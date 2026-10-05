import type { LocalDate } from '../../src/common/local-date.js';
import type { GrowthResultDto, TreeStateDto } from '../../src/trees/tree.contracts.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';
import {
  allHistory,
  expectedRecords,
  expectNeverLower,
  frozenMonth,
  get,
  MIN,
  recordsByKind,
  servedMonth,
  sid,
  summarize,
} from './x3-support.js';

/**
 * X3: one user lives the whole Core Loop through the public API, month after month, on a real
 * Nest app and PostgreSQL with a FixedClock:
 *
 *   April  A  light month              (first month, joined on the 1st)
 *   May       quiet (viewed, no focus) → resting
 *   June   B  consistent: rest days, a recovery, a weekly goal, a highlighted note
 *   July      discarded focus only     → resting; configuration version 2 activated
 *   August C  bursty, high focus       (pinned to version 2; closes with version 2's grace)
 *   Sept.  D  strong and sustained
 *   October   the current month: ceremony, a late September session, immutability, records
 *
 * Every month closes lazily, as in production: nothing moves except the clock.
 */

const t = new ConsistencyHarness('2026-04-01T00:01:00.000Z');

const REST_DAYS: LocalDate[] = ['2026-06-07', '2026-06-14', '2026-06-21'];
const RECOVERED: LocalDate[] = ['2026-06-09'];
const DAILY_GOAL = 45;
const WEEKLY_GOAL = { type: 'focused_minutes', target: 200 } as const;
const NOTE = 'Found the rhythm again.';

interface SessionBody {
  id: string;
  counted: boolean;
  growth: GrowthResultDto;
}

const dd = (month: number, day: number): LocalDate =>
  `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

describe('X3 Core Loop journey: months A–D, quiet months, closure, late session (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-04-01T00:01:00.000Z');
    await t.activateConfig();
  });

  it('keeps one coherent truth from the first session to Insights, across seven months', async () => {
    // ── 1–3. A new user, a time zone, a topic ────────────────────────────────────────────────
    const user = await t.signUp('journey@example.com', 'UTC', '2026-04-01T00:00:00.000Z');
    const writing = sid(9_000);
    await t
      .http()
      .put(`/me/topics/${writing}`)
      .set(user.auth)
      .send({ name: 'Writing', icon: 'pen', color: 'topic.2' })
      .expect(201);
    const first = await get<{ tree: TreeStateDto; pendingCeremony: unknown }>(t, user, '/me/home');
    expect(first.tree.progress.stage).toBe('seed');
    expect(first.tree.partialFirstMonth).toBe(false);
    expect(first.pendingCeremony).toBeNull();
    await t.http().put('/me/goals/daily').set(user.auth).send({ minutes: DAILY_GOAL }).expect(200);

    let n = 0;
    const lastTree = new Map<string, TreeStateDto>();
    const submitted: SessionBody[] = [];
    /** One day's sessions at 06:00 UTC onward, 5 minutes apart, submitted that evening. */
    async function focusDay(date: LocalDate, sessions: (number | [number, string])[]) {
      await t.setNow(`${date}T22:00:00.000Z`);
      let start = Date.parse(`${date}T06:00:00.000Z`);
      const out: SessionBody[] = [];
      for (const entry of sessions) {
        const [minutes, topicId] = typeof entry === 'number' ? [entry, user.topicId] : entry;
        const res = await t
          .submit({ ...user, topicId }, new Date(start).toISOString(), minutes, sid(++n))
          .expect(201);
        const body = res.body as SessionBody;
        const tree = body.growth.tree;
        if (tree) {
          const key = `${tree.year}-${tree.month}`;
          const before = lastTree.get(key);
          // 1. Structure, fullness, blossoms, richness, and traits never go down.
          if (before) expectNeverLower(before, tree);
          lastTree.set(key, tree);
        }
        out.push(body);
        submitted.push(body);
        start += (minutes + 5) * MIN;
      }
      return out;
    }
    const home = () =>
      get<{
        tree: TreeStateDto;
        goals: {
          daily: { today: { completed: boolean; focusedMinutes: number } };
          weekly: unknown;
        };
        streak: {
          current: number;
          today: string;
          recovery: { offer: unknown; usedThisMonth: number };
        };
        pendingCeremony: { year: number; month: number } | null;
      }>(t, user, '/me/home');
    const archivedTree = async (month: number) =>
      (await get<{ kind: string; tree: TreeStateDto }>(t, user, `/me/trees/2026/${month}`)).tree;

    // ── 4–11. April (A): the first session ───────────────────────────────────────────────────
    await t.setNow('2026-04-01T22:00:00.000Z');
    const firstId = sid(++n);
    const put = () => t.submit(user, '2026-04-01T06:00:00.000Z', 30, firstId);
    const accepted = (await put().expect(201)).body as SessionBody;
    submitted.push(accepted);
    expect(accepted.growth).toMatchObject({ counted: true, monthClosed: false });
    expect(accepted.growth.stage).toEqual({ from: 'seed', to: 'sprout' });
    lastTree.set('2026-4', accepted.growth.tree!);
    // 6. The growth result is stored with the session, immutably.
    const row = await t.prisma.focusSession.findFirst({ where: { id: firstId } });
    expect(row?.growthResult).toEqual(accepted.growth);
    // Replays return the stored result exactly, and grow nothing.
    const replay = await put().expect(200);
    expect((replay.body as SessionBody).growth).toEqual(accepted.growth);
    const replayRace = await Promise.all([put(), put(), put()]);
    for (const res of replayRace) expect((res.body as SessionBody).growth).toEqual(accepted.growth);
    expect(await t.prisma.focusSession.count({ where: { userId: user.userId } })).toBe(1);
    // 7, 11. Home, the current tree, and Tree Details agree with the growth result.
    const afterFirst = await home();
    expect(afterFirst.tree.progress).toEqual(accepted.growth.tree!.progress);
    expect(afterFirst.tree.traits).toEqual(accepted.growth.tree!.traits);
    expect((await get<{ tree: TreeStateDto }>(t, user, '/me/trees/current')).tree.progress).toEqual(
      accepted.growth.tree!.progress,
    );
    expect(
      (await get<{ kind: string; tree: TreeStateDto }>(t, user, '/me/trees/2026/4')).kind,
    ).toBe('growing');
    // 9–10. One counted session keeps a streak even with the daily goal not met.
    expect(afterFirst.goals.daily.today).toMatchObject({ completed: false, focusedMinutes: 30 });
    expect(afterFirst.streak).toMatchObject({ current: 1, today: 'active' });

    // 12. More sessions; a discarded one changes nothing.
    const april1Second = await t.submit(user, '2026-04-01T06:35:00.000Z', 30, sid(++n)).expect(201);
    submitted.push(april1Second.body as SessionBody);
    lastTree.set('2026-4', (april1Second.body as SessionBody).growth.tree!);
    const day2 = await focusDay(dd(4, 2), [50, 3]);
    expect(day2[1]!.counted).toBe(false);
    expect(day2[1]!.growth).toMatchObject({ counted: false, newTraits: [] });
    expect(day2[1]!.growth.tree?.progress).toEqual(day2[0]!.growth.tree!.progress);
    await focusDay(dd(4, 10), [35]);
    await focusDay(dd(4, 20), [35]);
    const aprilGrowing = (await home()).tree;

    // ── 13–17. The month ends; the grace period passes; reads race the closure ───────────────
    await t.setNow('2026-05-01T02:59:00.000Z');
    expect((await home()).pendingCeremony).toBeNull();
    expect((await frozenMonth(t, user.userId, 2026, 4)).tree?.status).toBe('growing');
    await t.setNow('2026-05-01T03:01:00.000Z');
    const race = await Promise.all([
      t.http().get('/me/home').set(user.auth),
      t.http().get('/me/forest').set(user.auth),
      t.http().get('/me/trees/current').set(user.auth),
      t.http().get('/me/trees/2026/4').set(user.auth),
      t.http().get('/me/trees/2026/4/recap').set(user.auth),
      t.http().get('/me/insights/month?year=2026&month=4').set(user.auth),
    ]);
    for (const res of race) expect(res.status).toBe(200);
    // 16. Exactly one archive, one recap, one closed_at.
    const april = await frozenMonth(t, user.userId, 2026, 4);
    expect(april.tree?.status).toBe('archived');
    expect(await t.prisma.monthlyRecap.count({ where: { userId: user.userId } })).toBe(1);
    expect(april.closedAt).not.toBeNull();
    const aprilDetails = await get<{ tree: TreeStateDto; stats: Record<string, unknown> }>(
      t,
      user,
      '/me/trees/2026/4',
    );
    expect(aprilDetails.tree).toEqual({ ...aprilGrowing, status: 'archived', vitality: null });
    // 17. The new month has its own tree.
    const mayHome = await home();
    expect(mayHome.tree).toMatchObject({ year: 2026, month: 5, status: 'growing' });
    expect(mayHome.tree.progress.stage).toBe('seed');
    // 19–20. The ceremony is pending once; seen marks are idempotent.
    expect(mayHome.pendingCeremony).toEqual({ year: 2026, month: 4 });
    const seen1 = await t.http().put('/me/trees/2026/4/ceremony-seen').set(user.auth).expect(200);
    const seen2 = await t.http().put('/me/trees/2026/4/ceremony-seen').set(user.auth).expect(200);
    expect(seen2.body).toEqual(seen1.body);
    const recapSeen1 = await t.http().put('/me/trees/2026/4/recap-seen').set(user.auth).expect(200);
    const recapSeen2 = await t.http().put('/me/trees/2026/4/recap-seen').set(user.auth).expect(200);
    expect(recapSeen2.body).toEqual(recapSeen1.body);
    expect((await home()).pendingCeremony).toBeNull();
    // 21. The recap is the stored snapshot.
    const aprilRecap = await get<{ stats: unknown; tree: TreeStateDto }>(
      t,
      user,
      '/me/trees/2026/4/recap',
    );
    expect(aprilRecap.stats).toEqual(aprilDetails.stats);
    expect(aprilRecap.tree).toEqual(aprilDetails.tree);

    // ── May: viewed, never focused ──────────────────────────────────────────────────────────
    await t.setNow('2026-06-01T03:01:00.000Z');
    const juneHome = await home();
    expect(juneHome.pendingCeremony).toBeNull(); // a resting month has no ceremony
    expect((await get<{ kind: string }>(t, user, '/me/trees/2026/5')).kind).toBe('resting');
    expect((await frozenMonth(t, user.userId, 2026, 5)).tree).toBeNull(); // no archived Seed

    // ── June (B): rest days, a recovery, a weekly goal, a highlighted note ───────────────────
    await t.http().put('/me/goals/weekly').set(user.auth).send(WEEKLY_GOAL).expect(200);
    for (const date of REST_DAYS) {
      await t.http().put(`/me/rest-days/${date}`).set(user.auth).expect(201);
    }
    const bDays = [1, 2, 3, 4, 5, 6, 8, 10, 12, 13, 15, 16, 18, 20, 21, 22, 24, 26, 28, 29, 30];
    for (const [i, day] of bDays.entries()) {
      const sessions: (number | [number, string])[] = i < 8 ? [20, [25, writing]] : [45];
      if (day === 8) {
        // 3. The rest day bridged the streak without counting, and is not a gap for vitality:
        // the morning after, two days since focus read as one (Healthy, not Stable).
        await t.setNow('2026-06-07T22:00:00.000Z');
        const rest = await home();
        expect(rest.streak).toMatchObject({ current: 6, today: 'rest' });
        expect(rest.tree.vitality).toBe('healthy');
        await t.setNow('2026-06-08T05:00:00.000Z');
        expect((await home()).tree.vitality).toBe('healthy');
      }
      await focusDay(dd(6, day), sessions);
      if (day === 10) {
        // Recovery: one missed day (9 June) after a streak of 7 (a rest day inside it).
        const offered = await home();
        expect(offered.streak.recovery.offer).toEqual({
          missedDate: '2026-06-09',
          returnDate: '2026-06-10',
          previousStreak: 7,
        });
        const treeBefore = await get<{ tree: TreeStateDto }>(t, user, '/me/trees/current');
        await t
          .http()
          .post('/me/streak/recoveries')
          .set(user.auth)
          .send({ missedDate: '2026-06-09' })
          .expect((res) => expect([200, 201]).toContain(res.status));
        const recovered = await home();
        // Bridged, not counted: 7 + the return day.
        expect(recovered.streak.current).toBe(8);
        const treeAfter = await get<{ tree: TreeStateDto }>(t, user, '/me/trees/current');
        // No growth, no direct vitality change.
        expect(treeAfter.tree.progress).toEqual(treeBefore.tree.progress);
        expect(treeAfter.tree.vitality).toBe(treeBefore.tree.vitality);
      }
      if (day === 12) {
        // One recovery per month: a second single missed day is not offered.
        const after = await home();
        expect(after.streak.recovery).toMatchObject({ offer: null, usedThisMonth: 1 });
        expect(after.streak.current).toBe(1);
      }
      if (day === 15) {
        const session = submitted.at(-1)!;
        await t
          .http()
          .patch(`/me/sessions/${session.id}/note`)
          .set(user.auth)
          .send({ note: NOTE })
          .expect(200);
        await t.http().put(`/me/sessions/${session.id}/note/highlight`).set(user.auth).expect(200);
      }
      if (day === 21) {
        // Focus on a rest day counts normally; the rest day stays scheduled.
        expect(submitted.at(-1)!.growth.counted).toBe(true);
        const restDays = await get<{ restDays: { date: string }[] }>(t, user, '/me/rest-days');
        expect(restDays.restDays.map((d) => d.date)).toContain('2026-06-21');
      }
    }
    const juneGrowing = (await home()).tree;

    // ── July: discarded focus only; configuration version 2 ─────────────────────────────────
    await t.setNow('2026-07-01T03:01:00.000Z');
    expect((await home()).pendingCeremony).toEqual({ year: 2026, month: 6 });
    const june = await get<{
      tree: TreeStateDto;
      stats: Record<string, unknown>;
      highlightedNotes: { sessionId: string; note: string }[];
    }>(t, user, '/me/trees/2026/6');
    expect(june.tree).toEqual({ ...juneGrowing, status: 'archived', vitality: null });
    expect(june.highlightedNotes.map((n) => n.note)).toEqual([NOTE]);
    await focusDay(dd(7, 15), [3, 2]);
    await t.http().post(`/me/topics/${writing}/archive`).set(user.auth).expect(200);
    await t.setNow('2026-07-20T12:00:00.000Z');
    await t.activateConfig({
      'growth.stageThresholds': [100, 300, 600, 1000, 1500],
      'session.monthGraceMinutes': 240,
    });

    // Version 2's grace applies to July: still open at +181 minutes, closed at +241.
    await t.setNow('2026-08-01T03:01:00.000Z');
    await home();
    expect((await frozenMonth(t, user.userId, 2026, 7)).closedAt).toBeNull();
    await t.setNow('2026-08-01T04:01:00.000Z');
    await home();
    expect((await frozenMonth(t, user.userId, 2026, 7)).closedAt).not.toBeNull();
    expect((await get<{ kind: string }>(t, user, '/me/trees/2026/7')).kind).toBe('resting');

    // ── August (C): bursty, pinned to version 2 ─────────────────────────────────────────────
    for (const [i, day] of [7, 8, 9, 10, 11, 12, 13, 21, 22, 23, 24, 25, 26, 27].entries()) {
      await focusDay(dd(8, day), i < 12 ? [46, 46, 45] : [69, 68]);
    }
    const augustGrowing = (await home()).tree;
    expect(augustGrowing.configVersion).toBe(2);

    // ── September (D): strong and sustained ─────────────────────────────────────────────────
    await t.setNow('2026-09-01T04:01:00.000Z');
    expect((await home()).pendingCeremony).toEqual({ year: 2026, month: 8 });
    const dDays = Array.from({ length: 30 }, (_, i) => i + 1).filter(
      (day) => ![6, 13, 20].includes(day),
    );
    for (const [i, day] of dDays.entries()) {
      await focusDay(dd(9, day), i < 6 ? [34, 33, 33] : [50, 50]);
    }
    const septemberGrowing = (await home()).tree;

    // ── October: September closes; ceremony; current month ──────────────────────────────────
    await t.setNow('2026-10-01T04:01:00.000Z');
    const october = await home();
    expect(october.pendingCeremony).toEqual({ year: 2026, month: 9 });
    expect(october.tree).toMatchObject({ year: 2026, month: 10, configVersion: 2 });
    await focusDay(dd(10, 1), [25]);

    // ── Months A–D, as the configuration shapes them ─────────────────────────────────────────
    const A = await archivedTree(4);
    const B = await archivedTree(6);
    const C = await archivedTree(8);
    const D = await archivedTree(9);
    expect(B).toEqual({ ...juneGrowing, status: 'archived', vitality: null });
    expect(C).toEqual({ ...augustGrowing, status: 'archived', vitality: null });
    expect(D).toEqual({ ...septemberGrowing, status: 'archived', vitality: null });
    expect([A.configVersion, B.configVersion, C.configVersion, D.configVersion]).toEqual([
      1, 1, 2, 2,
    ]);
    // A: small, no traits, the goal met now and then.
    expect(A.progress.stageNumber).toBeLessThanOrEqual(3);
    expect(A.traits).toEqual([]);
    expect(aprilDetails.stats['dailyGoalsMet']).toBeGreaterThan(0);
    // B: fuller, streak traits, several goals.
    expect(B.progress.stageNumber).toBeGreaterThan(A.progress.stageNumber);
    expect(B.progress.fullness.level).toBeGreaterThan(A.progress.fullness.level);
    expect(B.traits.map((trait) => trait.id)).toEqual(
      expect.arrayContaining(['streak-days:3', 'streak-days:7']),
    );
    expect(june.stats['dailyGoalsMet']).toBeGreaterThan(
      aprilDetails.stats['dailyGoalsMet'] as number,
    );
    // C: a larger stage than B, less full.
    expect(C.progress.stageNumber).toBeGreaterThan(B.progress.stageNumber);
    expect(C.progress.fullness.level).toBeLessThan(B.progress.fullness.level);
    // D: Final Form, full, blossoming, rich, several traits.
    expect(D.progress.stage).toBe('final_form');
    expect(D.progress.fullness.level).toBe(D.progress.fullness.maxLevel);
    expect(D.progress.blossoms.level).toBeGreaterThan(B.progress.blossoms.level);
    expect(D.progress.richness.tier).toBeGreaterThanOrEqual(C.progress.richness.tier);
    expect(D.traits.length).toBeGreaterThanOrEqual(3);

    // ── 18. Forest: archived and quiet months, every month once ─────────────────────────────
    const forest = await get<{
      items: { kind: string; year: number; month: number; focusedMilliseconds: number }[];
      nextCursor: string | null;
      progression: { level: number; treeCount: number; unlockedAreas: string[] };
    }>(t, user, '/me/forest');
    expect(forest.items.map((item) => `${item.month}:${item.kind}`)).toEqual([
      '10:growing',
      '9:archived',
      '8:archived',
      '7:resting',
      '6:archived',
      '5:resting',
      '4:archived',
    ]);
    expect(forest.nextCursor).toBeNull();
    for (const item of forest.items) {
      if (item.kind === 'resting') expect(item.focusedMilliseconds).toBe(0);
      if (item.kind === 'archived') {
        const details = await get<{ stats: { focusedMinutes: number } }>(
          t,
          user,
          `/me/trees/2026/${item.month}`,
        );
        expect(item.focusedMilliseconds).toBe(details.stats.focusedMinutes * MIN);
      }
    }
    expect(forest.items[0]!.focusedMilliseconds).toBe(25 * MIN);
    // 10. Progression from planted trees only (resting months do not count).
    expect(forest.progression).toMatchObject({ treeCount: 4, level: 3 });
    expect(forest.progression.unlockedAreas).toEqual(['lake', 'mountains']);

    // ── 13. Three weekly metrics, three meanings ───────────────────────────────────────────
    // The week of Monday 31 August reached its goal on 2 September.
    const weekAug31 = await get<{ goals: { weekly: Record<string, unknown> } }>(
      t,
      user,
      '/me/insights/week?weekStart=2026-08-31',
    );
    expect(weekAug31.goals.weekly).toMatchObject({
      weekStart: '2026-08-31',
      target: 200,
      completed: true,
    });
    const augustInsights = await get<{
      goals: { weekly: { completed: number; eligible: number } };
      archivedStats: { weeklyGoalsMet: number };
    }>(t, user, '/me/insights/month?year=2026&month=8');
    // Rate: weeks owned by their Monday (3, 10, 17, 24, 31 August), all met.
    expect(augustInsights.goals.weekly).toEqual({ completed: 5, eligible: 5 });
    // Archived count: weeks met on an August date (31 August's week was met in September).
    expect(augustInsights.archivedStats.weeklyGoalsMet).toBe(4);

    // ── 22. Insights == History, from the rows (June and the week of 8 June) ─────────────────
    for (const [insightsPath, historyQuery] of [
      ['/me/insights/month?year=2026&month=6', 'month=2026-06'],
      ['/me/insights/week?weekStart=2026-06-08', 'week=2026-06-08'],
      ['/me/insights/month?year=2026&month=7', 'month=2026-07'],
    ] as const) {
      const rows = await allHistory(t, user, historyQuery);
      const expected = summarize(rows);
      const insights = await get<{
        summary: { focusedMilliseconds: number; sessionCount: number; activeDays: number };
        topics: { topicId: string; status: string; focusedMilliseconds: number; share: number }[];
        longestSession: { focusedMilliseconds: number } | null;
        days: { date: string; focusedMilliseconds: number; active: boolean; rest: boolean }[];
      }>(t, user, insightsPath);
      expect(insights.summary).toMatchObject({
        focusedMilliseconds: expected.focusedMilliseconds,
        sessionCount: expected.sessionCount,
        activeDays: expected.activeDays,
      });
      expect(
        Object.fromEntries(
          insights.topics.map((topic) => [topic.topicId, topic.focusedMilliseconds]),
        ),
      ).toEqual(
        Object.fromEntries(
          [...expected.topics].map(([id, topic]) => [id, topic.focusedMilliseconds]),
        ),
      );
      if (insights.topics.length > 0) {
        expect(insights.topics.reduce((sum, topic) => sum + topic.share, 0)).toBeCloseTo(1, 6);
      }
      expect(insights.longestSession?.focusedMilliseconds ?? 0).toBe(expected.longestMilliseconds);
      for (const cell of insights.days) {
        expect(cell.focusedMilliseconds).toBe(expected.byDate.get(cell.date) ?? 0);
      }
    }
    const juneInsights = await get<{
      topics: { topicId: string; status: string }[];
      days: { date: string; active: boolean; rest: boolean; sessionCount: number }[];
    }>(t, user, '/me/insights/month?year=2026&month=6');
    // The archived topic keeps its history.
    expect(juneInsights.topics.find((topic) => topic.topicId === writing)?.status).toBe('archived');
    // Rest and focus are both kept; the recovered day is not an active day.
    expect(juneInsights.days.find((d) => d.date === '2026-06-21')).toMatchObject({
      active: true,
      rest: true,
    });
    expect(juneInsights.days.find((d) => d.date === '2026-06-09')).toMatchObject({
      active: false,
      sessionCount: 0,
    });
    // July: discarded sessions are visible but add nothing.
    const julyRows = await allHistory(t, user, 'month=2026-07');
    expect(julyRows.map((r) => r.counted)).toEqual([false, false]);

    // ── 6, 9. D4: a late September session, after the archive ───────────────────────────────
    await t.setNow('2026-10-02T09:00:00.000Z');
    const septBefore = await frozenMonth(t, user.userId, 2026, 9);
    const septServedBefore = await servedMonth(t, user, 2026, 9);
    const recordsBefore = await get<{
      records: { kind: string; value: number; achievedOn: string }[];
    }>(t, user, '/me/insights/records');
    const statsBefore = await get<{ focusedMilliseconds: number; sessionCount: number }>(
      t,
      user,
      '/me/profile/stats',
    );
    const lateId = sid(99_001);
    const late = () => t.submit(user, '2026-09-29T04:00:00.000Z', 70, lateId);
    const lateBody = (await late().expect(201)).body as SessionBody;
    expect(lateBody.counted).toBe(true);
    expect(lateBody.growth).toEqual({
      counted: true,
      monthClosed: true,
      newTraits: [],
      tree: null,
    });
    expect(((await late().expect(200)).body as SessionBody).growth).toEqual(lateBody.growth);
    expect(await frozenMonth(t, user.userId, 2026, 9)).toEqual(septBefore);
    expect(await servedMonth(t, user, 2026, 9)).toEqual(septServedBefore);
    // History, lifetime stats, Insights' raw numbers, and derived records include it.
    const septRows = await allHistory(t, user, 'month=2026-09');
    expect(septRows.map((r) => r.id)).toContain(lateId);
    expect(await get(t, user, '/me/profile/stats')).toMatchObject({
      focusedMilliseconds: statsBefore.focusedMilliseconds + 70 * MIN,
      sessionCount: statsBefore.sessionCount + 1,
      archivedTreeCount: 4,
    });
    const septInsights = await get<{
      summary: { focusedMilliseconds: number };
      archivedStats: { focusedMinutes: number };
    }>(t, user, '/me/insights/month?year=2026&month=9');
    expect(septInsights.summary.focusedMilliseconds).toBe(summarize(septRows).focusedMilliseconds);
    expect(septInsights.summary.focusedMilliseconds).toBe(
      (septInsights.archivedStats.focusedMinutes + 70) * MIN,
    );
    const recordsAfter = await get<{
      records: { kind: string; value: number; achievedOn: string }[];
    }>(t, user, '/me/insights/records');
    expect(recordsByKind(recordsAfter.records)['longest_session']).toEqual({
      value: 70,
      achievedOn: '2026-09-29',
    });
    expect(recordsByKind(recordsBefore.records)['longest_session']?.value).toBe(69);
    // An equal day later never replaces the earliest: every C day had 137 minutes.
    expect(recordsByKind(recordsBefore.records)['most_focused_day']).toEqual({
      value: 137,
      achievedOn: '2026-08-07',
    });

    // ── 12, 23. Records: all six, recomputed from History rows ──────────────────────────────
    const everything = await allHistory(t, user);
    const expected = expectedRecords(everything, {
      restDates: REST_DAYS,
      recoveredDates: RECOVERED,
      dailyGoalMinutes: DAILY_GOAL,
    });
    expect(recordsByKind(recordsAfter.records)).toEqual(expected);
    const streak = await get<{ longest: number }>(t, user, '/me/streak');
    expect(expected.longest_streak?.value).toBe(streak.longest);

    // ── 9, 24. Archives never change, whatever stays mutable ────────────────────────────────
    const archives = [4, 6, 8, 9];
    const frozenBefore = await Promise.all(
      archives.map((m) => frozenMonth(t, user.userId, 2026, m)),
    );
    const servedBefore = [];
    for (const m of archives) servedBefore.push(await servedMonth(t, user, 2026, m));
    const highlighted = june.highlightedNotes[0]!.sessionId;
    await t
      .http()
      .patch(`/me/sessions/${highlighted}/note`)
      .set(user.auth)
      .send({ note: 'Edited later.' })
      .expect(200);
    await t.http().delete(`/me/sessions/${highlighted}/note/highlight`).set(user.auth).expect(200);
    await t
      .http()
      .patch('/me/profile')
      .set(user.auth)
      .send({ timezone: 'Asia/Ho_Chi_Minh' })
      .expect(200);
    await t.activateConfig({
      'growth.stageThresholds': [60, 120, 240, 480, 960],
      'forest.levelThresholds': [10, 20, 30, 40, 50],
    });
    const afterRaise = await get<{ progression: { level: number; unlockedAreas: string[] } }>(
      t,
      user,
      '/me/forest',
    );
    // Higher thresholds lower the level but never relock an area.
    expect(afterRaise.progression.level).toBe(1);
    expect(afterRaise.progression.unlockedAreas).toEqual(['lake', 'mountains']);
    await t.activateConfig({ 'forest.levelThresholds': [1, 2, 3, 4, 5] });
    const afterLower = await get<{ progression: { level: number; unlockedAreas: string[] } }>(
      t,
      user,
      '/me/forest',
    );
    expect(afterLower.progression.level).toBe(5);
    expect(afterLower.progression.unlockedAreas).toEqual([
      'lake',
      'mountains',
      'night',
      'seasonal',
    ]);
    for (const [i, m] of archives.entries()) {
      expect(await frozenMonth(t, user.userId, 2026, m)).toEqual(frozenBefore[i]);
      expect(await servedMonth(t, user, 2026, m)).toEqual(servedBefore[i]);
    }
    const juneAfter = await get<{ highlightedNotes: unknown; tree: TreeStateDto }>(
      t,
      user,
      '/me/trees/2026/6',
    );
    expect(juneAfter.highlightedNotes).toEqual(june.highlightedNotes);
    expect(juneAfter.tree.vitality).toBeNull();
    // The month context keeps its time zone; the next month uses the new one.
    expect((await frozenMonth(t, user.userId, 2026, 10)).timezone).toBe('UTC');

    // The whole journey stored each session once.
    expect(new Set(submitted.map((s) => s.id)).size).toBe(submitted.length);
    expect(await t.prisma.focusSession.count({ where: { userId: user.userId } })).toBe(
      submitted.length + 1,
    );
    expect(await t.prisma.monthlyRecap.count({ where: { userId: user.userId } })).toBe(4);
  }, 600_000);
});
