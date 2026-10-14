import type { TreeStateDto } from '../../src/trees/tree.contracts.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * Final review FR.3: one person's first month, where the core rules meet (HTTP + PostgreSQL).
 *
 * Every expected number below was computed by hand from the product docs, not read from the code:
 * the feature spec, docs/03 (growth, soft cap, proration, vitality), and docs/06 (attribution,
 * goals, rest days, streak, recovery, closure, late sessions, recap, records, Insights).
 *
 * Mai lives in Ho Chi Minh City (UTC+7, no daylight saving) and joins on Friday 16 October 2026.
 * October 2026 starts on a Thursday, so the weeks are 12–18, 19–25, and 26 October–1 November.
 *
 * | Local date | What happens | Counted minutes |
 * |---|---|---|
 * | Fri 16 | joins; daily goal 60, weekly goal 300 min (this week) | 60 (goal met) |
 * | Sat 17 | one 300-minute session (past the 240 soft cap); plans Sunday as rest | 300 (met; week 360 ≥ 300) |
 * | Sun 18 | rest day, no focus | 0 |
 * | Mon 19 | 30 min; lowers the daily goal to 30 (from tomorrow) | 30 (not met: 60 today) |
 * | Tue 20 | | 30 (met) |
 * | Wed 21 | takes today as rest, then focuses anyway | 45 (met; stays a rest day) |
 * | Thu 22 | nothing | 0 |
 * | Fri 23 | 25 min; accepts the recovery of the 22nd | 25 (not met) |
 * | Sat 24 | a 3-minute session (discarded), then 40 | 40 (met) |
 * | Sun 25 | 23:30–00:20, across midnight | 50 (met, on the 25th) |
 * | 26–27 | nothing; on the 27th the profile moves to Berlin | 0 |
 * | 29 | 02:00 in HCM (20:00 on the 28th in Berlin) | 20 (not met) |
 * | Sat 31 | 23:30–01:00, across the month end | 90 (met) |
 * | (2 Nov) | a forgotten session of the 30th arrives late | 40, after the month closed |
 */

const MIN = 60_000;
const t = new ConsistencyHarness('2026-10-16T02:00:00.000Z');
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

/** "2026-10-16T10:00" in Ho Chi Minh City (UTC+7) → the ISO instant. */
const hcm = (local: string) =>
  new Date(Date.parse(`${local}:00.000Z`) - 7 * 60 * MIN).toISOString();
const after = (iso: string, minutes: number) =>
  new Date(Date.parse(iso) + minutes * MIN).toISOString();

interface Submitted {
  localDate: string;
  year: number;
  month: number;
  counted: boolean;
  growth: { counted: boolean; monthClosed: boolean; newTraits: unknown[]; tree: unknown };
}

describe('final review FR.3: a lived first month (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-16T02:00:00.000Z');
    await t.activateConfig();
  });

  const get = async <T>(user: User, path: string) =>
    (await t.http().get(path).set(user.auth).expect(200)).body as T;
  /** Submits `minutes` from a Ho Chi Minh City local time, with the clock just after its end. */
  async function focus(user: User, local: string, minutes: number): Promise<Submitted> {
    const start = hcm(local);
    await t.setNow(after(start, minutes + 1));
    return (await t.submit(user, start, minutes).expect(201)).body as Submitted;
  }

  it('tells one story everywhere: tree, streak, goals, archive, recap, Insights, records', async () => {
    const mai = await t.signUp('mai@example.com', 'Asia/Ho_Chi_Minh', '2026-10-16T02:00:00.000Z');
    await t.http().put('/me/goals/daily').set(mai.auth).send({ minutes: 60 }).expect(200);
    await t
      .http()
      .put('/me/goals/weekly')
      .set(mai.auth)
      .send({ type: 'focused_minutes', target: 300 })
      .expect(200);

    // Fri 16 and Sat 17; Sunday is planned as rest the day before.
    await focus(mai, '2026-10-16T10:00', 60);
    await focus(mai, '2026-10-17T08:00', 300);
    await t.http().put('/me/rest-days/2026-10-18').set(mai.auth).expect(201);

    // Mon 19: the goal change applies from the next local day (docs/06 DailyGoal).
    await focus(mai, '2026-10-19T09:00', 30);
    await t.http().put('/me/goals/daily').set(mai.auth).send({ minutes: 30 }).expect(200);
    await focus(mai, '2026-10-20T09:00', 30);

    // Wed 21: a rest day set today, then focus anyway. It stays a rest day (docs/06 RestDay).
    await t.setNow(hcm('2026-10-21T08:00'));
    await t.http().put('/me/rest-days/2026-10-21').set(mai.auth).expect(201);
    await focus(mai, '2026-10-21T09:00', 45);

    // Thu 22 missed; Fri 23 back. Before the 22nd: active 16, 17, 19, 20 (18 and 21 are rest
    // days, which bridge without counting) = 4 ≥ 3, so the recovery is offered (docs/06).
    await focus(mai, '2026-10-23T09:00', 25);
    expect(await get(mai, '/me/streak')).toMatchObject({
      current: 1,
      longest: 4,
      recovery: {
        offer: { missedDate: '2026-10-22', returnDate: '2026-10-23', previousStreak: 4 },
        usedThisMonth: 0,
      },
    });
    const recovered = await t
      .http()
      .post('/me/streak/recoveries')
      .set(mai.auth)
      .send({ missedDate: '2026-10-22' })
      .expect(201);
    // 16, 17, 19, 20, 23 are active; 18, 21 (rest) and 22 (recovered) connect without adding.
    expect(recovered.body).toMatchObject({ current: 5, longest: 5 });

    // Sat 24: 3 minutes never count (session.minValidMinutes 5), then 40.
    const short = await focus(mai, '2026-10-24T09:00', 3);
    expect(short).toMatchObject({ counted: false, growth: { counted: false } });
    await focus(mai, '2026-10-24T10:00', 40);

    // Sun 25: 23:30 to 00:20 belongs to the 25th, the day it started (docs/06).
    const midnight = await focus(mai, '2026-10-25T23:30', 50);
    expect(midnight).toMatchObject({ localDate: '2026-10-25', year: 2026, month: 10 });
    // Seven active days in the run (16, 17, 19, 20, 23, 24, 25): the 7-day milestone.
    expect(await get(mai, '/me/streak')).toMatchObject({ current: 7, longest: 7 });

    // Tue 27: Mai moves to Berlin. October keeps its Ho Chi Minh City time zone (docs/06).
    await t.setNow('2026-10-27T10:00:00.000Z');
    await t
      .http()
      .patch('/me/profile')
      .set(mai.auth)
      .send({ timezone: 'Europe/Berlin' })
      .expect(200);

    // 01:59 on the 29th in HCM: 26, 27, and 28 passed without focus, so the tree is Quiet
    // (3+ days, docs/03 §6); one session wakes it: Recovering.
    await t.setNow('2026-10-28T18:59:00.000Z');
    const quiet = await get<{ tree: TreeStateDto }>(mai, '/me/home');
    expect(quiet.tree.vitality).toBe('quiet');
    await t.setNow('2026-10-28T19:21:00.000Z');
    const berlinEvening = (await t.submit(mai, '2026-10-28T19:00:00.000Z', 20).expect(201))
      .body as Submitted;
    // 20:00 on the 28th in Berlin is 02:00 on the 29th in October's time zone.
    expect(berlinEvening).toMatchObject({ localDate: '2026-10-29', month: 10 });
    expect((await get<{ tree: TreeStateDto }>(mai, '/me/home')).tree.vitality).toBe('recovering');

    // Sat 31: 23:30 to 01:00 belongs to October, though it ends in November.
    const lastNight = await focus(mai, '2026-10-31T23:30', 90);
    expect(lastNight).toMatchObject({
      localDate: '2026-10-31',
      month: 10,
      growth: { counted: true, monthClosed: false },
    });

    /*
     * The growing tree, by hand:
     * - growth: the 300-minute day is capped, 240 + 60 × 40 % = 264; the rest count in full:
     *   690 − 300 + 264 = 654 minutes;
     * - partial first month: 16 of 31 days remain (the join day included), above the 25 % floor,
     *   so the thresholds are 120/360/720/1200/1800 × 16/31 = 61.9/185.8/371.6/619.4/929.0;
     *   654 is past 619.4 and short of 929.0: Blooming Tree;
     * - blossoms: 7 daily goals (16, 17, 20, 21, 24, 25, 31) × 1 + 1 weekly goal (met on the
     *   17th) × 2 = 9 points. The month's growth expectations are prorated (docs/06
     *   `growth.firstMonthProration`), so the thresholds 1/3/6/10/15/21/28 become
     *   0.5/1.5/3.1/5.2/7.7/10.8/14.5: level 5;
     * - traits: 11.5 focused hours (not capped, not prorated) reach the 10-hour milestone; the
     *   streak reached 3 (on the 19th) and 7 (on the 25th);
     * - richness: none before Final Form.
     */
    // October ended at 17:00 UTC, so Home shows November; October is in its grace period and
    // still growing (docs/06), read through Tree Details.
    expect((await get<{ tree: TreeStateDto }>(mai, '/me/home')).tree).toMatchObject({ month: 11 });
    const growing = (await get<{ tree: TreeStateDto }>(mai, '/me/trees/2026/10')).tree;
    expect(growing).toMatchObject({
      year: 2026,
      month: 10,
      status: 'growing',
      partialFirstMonth: true,
    });
    expect(growing.progress).toMatchObject({
      stage: 'blooming_tree',
      growthMinutes: 654,
      blossoms: { level: 5 },
      richness: { tier: 0 },
    });
    expect(growing.traits.map((trait) => trait.id).sort()).toEqual([
      'monthly-focus-hours:10',
      'streak-days:3',
      'streak-days:7',
    ]);

    // October ends at midnight in HCM (17:00 UTC); it closes after the 180-minute grace.
    await t.setNow('2026-10-31T20:01:00.000Z');
    const home = await get<{ pendingCeremony: unknown }>(mai, '/me/home');
    expect(home.pendingCeremony).toEqual({ year: 2026, month: 10 });

    /*
     * The archive, by hand: 10 counted sessions (the discarded one is history only), 690
     * minutes, 10 active days (the rest day with focus included), 7 daily and 1 weekly goal,
     * a longest streak of 7.
     */
    type Details = { tree: TreeStateDto; stats: Record<string, unknown> };
    const archived = await get<Details>(mai, '/me/trees/2026/10');
    expect(archived.tree).toEqual({ ...growing, status: 'archived', vitality: null });
    expect(archived.stats).toMatchObject({
      focusedMinutes: 690,
      sessionCount: 10,
      activeDays: 10,
      dailyGoalsMet: 7,
      weeklyGoalsMet: 1,
      longestStreak: 7,
    });

    /*
     * The recap: the best day is the 17th (300); the best week starts Monday the 12th
     * (60 + 300 = 360, against 220 and 110). A first month sets every record it has; the
     * daily-goal streak is 2 (16–17: the rest day on the 18th bridges, the 19th ends it), first
     * reached on the 17th.
     */
    type Recap = {
      stats: unknown;
      mostProductiveDay: unknown;
      mostProductiveWeek: unknown;
      newRecords: { kind: string; value: number; achievedOn: string }[];
    };
    const recap = await get<Recap>(mai, '/me/trees/2026/10/recap');
    expect(recap.stats).toEqual(archived.stats);
    expect(recap.mostProductiveDay).toEqual({ date: '2026-10-17', focusedMinutes: 300 });
    expect(recap.mostProductiveWeek).toEqual({ weekStart: '2026-10-12', focusedMinutes: 360 });
    const records = (list: { kind: string; value: number; achievedOn: string }[]) =>
      Object.fromEntries(list.map((r) => [r.kind, [r.value, r.achievedOn]]));
    expect(records(recap.newRecords)).toEqual({
      most_focused_day: [300, '2026-10-17'],
      most_focused_week: [360, '2026-10-12'],
      most_focused_month: [690, '2026-10-01'],
      longest_streak: [7, '2026-10-25'],
      longest_session: [300, '2026-10-17'],
      longest_daily_goal_streak: [2, '2026-10-17'],
    });

    // 2 November: a forgotten session of the 30th arrives. It is kept and counted, but the
    // archived tree and recap never change (docs/06 Late sessions).
    await t.setNow('2026-11-02T03:00:00.000Z');
    const late = (await t.submit(mai, hcm('2026-10-30T10:00'), 40).expect(201)).body as Submitted;
    expect(late).toMatchObject({
      localDate: '2026-10-30',
      month: 10,
      growth: { counted: true, monthClosed: true, newTraits: [], tree: null },
    });
    expect(await get<Details>(mai, '/me/trees/2026/10')).toEqual(archived);
    expect(await get<Recap>(mai, '/me/trees/2026/10/recap')).toEqual(recap);

    /*
     * Insights count the late session (730 minutes, 11 sessions, 11 active days) and show the
     * archive apart. Daily goal rate: 16–31 October had a goal and are decided (16 days); the
     * rest day on the 18th without the goal met is left out (15); met: 16, 17, 20, 21, 24, 25,
     * 30 (late, 40 ≥ 30), 31 = 8. Weekly: the weeks of Mondays 12, 19, and 26 October had the
     * goal and have ended; only the 12th's was met. The week of the 5th had none.
     */
    const insights = await get<{
      summary: { focusedMilliseconds: number; sessionCount: number; activeDays: number };
      goals: { daily: { completed: number; eligible: number }; weekly: unknown };
      archivedStats: unknown;
    }>(mai, '/me/insights/month?year=2026&month=10');
    expect(insights.summary).toMatchObject({
      focusedMilliseconds: 730 * MIN,
      sessionCount: 11,
      activeDays: 11,
    });
    expect(insights.archivedStats).toEqual(archived.stats);
    expect(insights.goals.daily).toEqual({ completed: 8, eligible: 15 });
    expect(insights.goals.weekly).toEqual({ completed: 1, eligible: 3 });

    // History shows all 12 sessions, the discarded one included, and its counted total agrees.
    const history = await get<{ items: { counted: boolean; focusedMilliseconds: number }[] }>(
      mai,
      '/me/sessions?month=2026-10&limit=100',
    );
    expect(history.items).toHaveLength(12);
    expect(
      history.items.filter((s) => s.counted).reduce((sum, s) => sum + s.focusedMilliseconds, 0),
    ).toBe(730 * MIN);

    // Lifetime numbers and records include the late session; the month record now reads 730.
    expect(await get(mai, '/me/profile/stats')).toMatchObject({
      focusedMilliseconds: 730 * MIN,
      sessionCount: 11,
      archivedTreeCount: 1,
    });
    const lifetime = await get<{ records: { kind: string; value: number; achievedOn: string }[] }>(
      mai,
      '/me/insights/records',
    );
    expect(records(lifetime.records)).toMatchObject({
      most_focused_month: [730, '2026-10-01'],
      longest_streak: [7, '2026-10-25'],
    });
  }, 300_000);
});
