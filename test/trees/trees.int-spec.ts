import { randomUUID } from 'node:crypto';

import type { GrowthResultDto, TreeStateDto } from '../../src/trees/tree.contracts.js';
import { variationSeed } from '../../src/trees/variation-seed.js';
import { ConsistencyHarness, dateRange } from '../support/consistency-harness.js';

// Wednesday 7 October 2026, 20:00 UTC.
const NOW = '2026-10-07T20:00:00.000Z';
const t = new ConsistencyHarness(NOW);

interface CurrentTreeBody {
  tree: TreeStateDto;
  stats: {
    focusedMinutes: number;
    sessionCount: number;
    activeDays: number;
    dailyGoalsMet: number;
    weeklyGoalsMet: number;
    topTopicId: string | null;
  };
}

interface SessionBody {
  id: string;
  status: string;
  counted: boolean;
  localDate: string;
  year: number;
  month: number;
  growth: GrowthResultDto | null;
}

const PHASE2_FIELDS = [
  'counted',
  'createdAt',
  'endedAt',
  'focusedMilliseconds',
  'id',
  'localDate',
  'month',
  'note',
  'noteHighlighted', // A3.4
  'pausedMilliseconds',
  'plannedMinutes',
  'startedAt',
  'status',
  'topicId',
  'year',
];

type User = Awaited<ReturnType<typeof t.signUp>>;

describe('monthly tree and session growth (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow(NOW);
    await t.activateConfig();
  });

  const current = async (user: User) =>
    (await t.http().get('/me/trees/current').set(user.auth).expect(200)).body as CurrentTreeBody;
  const submitted = async (user: User, startedAt: string, minutes: number, id?: string) =>
    (await t.submit(user, startedAt, minutes, id).expect(201)).body as SessionBody;
  const treeRow = (user: User, month = 10) =>
    t.prisma.monthlyTree.findUniqueOrThrow({
      where: { userId_year_month: { userId: user.userId, year: 2026, month } },
    });
  const traitIds = async (user: User) =>
    (await t.prisma.monthlyTreeTrait.findMany({ where: { userId: user.userId } }))
      .map((row) => row.traitId)
      .sort();

  /** Creates a trigger that makes one statement fail, runs `body`, then removes it. */
  async function withFailure(table: string, when: string, body: () => Promise<void>) {
    await t.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'failed on purpose'; END $$ LANGUAGE plpgsql`);
    await t.prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_fail ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION test_fail()`,
    );
    try {
      await body();
    } finally {
      await t.prisma.$executeRawUnsafe(`DROP TRIGGER test_fail ON ${table}`);
    }
  }

  describe('current tree', () => {
    it('is a Seed before any focus, with the month’s stable seed', async () => {
      const ada = await t.signUp('ada@example.com');
      const first = await current(ada);
      expect(first).toEqual({
        tree: {
          year: 2026,
          month: 10,
          status: 'growing',
          species: 'signature',
          variationSeed: variationSeed({ userId: ada.userId, year: 2026, month: 10 }),
          partialFirstMonth: false,
          configVersion: expect.any(Number) as number,
          progress: {
            stage: 'seed',
            stageNumber: 1,
            progressToNextStage: 0,
            growthMinutes: 0,
            fullness: { level: 0, maxLevel: 5 },
            blossoms: { level: 0, maxLevel: 7 },
            richness: { tier: 0, maxTier: 5 },
          },
          traits: [],
          vitality: 'healthy',
        },
        stats: {
          focusedMinutes: 0,
          sessionCount: 0,
          activeDays: 0,
          dailyGoalsMet: 0,
          weeklyGoalsMet: 0,
          topTopicId: null,
        },
      });
      expect(await current(ada)).toEqual(first);
      expect(await t.prisma.monthlyTree.count()).toBe(1);
    });

    it('is created once, however many first reads arrive together', async () => {
      const ada = await t.signUp('ada@example.com');
      const bodies = await Promise.all(
        Array.from({ length: 5 }, () => t.http().get('/me/trees/current').set(ada.auth)),
      );
      expect(bodies.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      expect(new Set(bodies.map((res) => JSON.stringify(res.body))).size).toBe(1);
      expect(await t.prisma.monthlyTree.count()).toBe(1);
    });

    it('is created once when first reads arrive together for a month that already has sessions', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [['2026-10-02', 30]]); // October's context exists, its tree does not
      const bodies = await Promise.all(
        Array.from({ length: 5 }, () => t.http().get('/me/trees/current').set(ada.auth)),
      );
      expect(bodies.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      expect(await t.prisma.monthlyTree.count()).toBe(1);
    });

    it('starts from the month’s stored sessions when first viewed after them', async () => {
      // Sessions stored before the tree existed (for example before Phase 3).
      const ada = await t.signUp('ada@example.com');
      await t.focus(
        ada,
        dateRange('2026-10-01', 5).map((date) => [date, 120] as [string, number]),
      );
      const { tree } = await current(ada);
      expect(tree.progress).toMatchObject({ stage: 'growing_tree', growthMinutes: 600 });
      expect(tree.traits.map((trait) => trait.id)).toEqual([
        'monthly-focus-hours:10',
        'streak-days:3',
      ]);
      // The next session reports only what it changed.
      const next = await submitted(ada, '2026-10-07T10:00:00.000Z', 10);
      expect(next.growth).not.toHaveProperty('stage');
      expect(next.growth?.newTraits).toEqual([]);
    });

    it('needs a time zone, like sessions', async () => {
      const ada = await t.signUp('ada@example.com', null);
      const res = await t.http().get('/me/trees/current').set(ada.auth).expect(422);
      expect((res.body as { code: string }).code).toBe('timezone_required');
      expect(await t.prisma.monthlyTree.count()).toBe(0);
    });

    it('keeps each user’s tree separate', async () => {
      const ada = await t.signUp('ada@example.com');
      const bob = await t.signUp('bob@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 30);
      const bobs = await current(bob);
      expect(bobs.tree.progress.stage).toBe('seed');
      expect(bobs.stats.sessionCount).toBe(0);
      expect(bobs.tree.variationSeed).not.toBe((await current(ada)).tree.variationSeed);
    });

    it('requires sign-in', async () => {
      await t.http().get('/me/trees/current').expect(401);
      await t.http().get('/me/home').expect(401);
    });
  });

  describe('session growth', () => {
    it('grows a Seed into a Sprout with the first counted session, adding `growth` only', async () => {
      const ada = await t.signUp('ada@example.com');
      const res = await t.submit(ada, '2026-10-07T10:00:00.000Z', 5).expect(201);
      const body = res.body as SessionBody;

      expect(Object.keys(body).sort()).toEqual([...PHASE2_FIELDS, 'growth'].sort());
      expect(body).toMatchObject({
        status: 'completed',
        counted: true,
        localDate: '2026-10-07',
        year: 2026,
        month: 10,
      });
      expect(body.growth).toEqual({
        counted: true,
        monthClosed: false,
        stage: { from: 'seed', to: 'sprout' },
        newTraits: [],
        tree: expect.objectContaining({
          year: 2026,
          month: 10,
          progress: expect.objectContaining({ stage: 'sprout', growthMinutes: 5 }) as unknown,
        }) as unknown,
      });
      expect((await treeRow(ada)).stage).toBe('sprout');
    });

    it('stores a discarded session without any growth, and says so', async () => {
      const ada = await t.signUp('ada@example.com');
      const body = await submitted(ada, '2026-10-07T10:00:00.000Z', 2);
      expect(body.status).toBe('discarded');
      expect(body.growth).toEqual({
        counted: false,
        monthClosed: false,
        newTraits: [],
        tree: expect.objectContaining({
          progress: expect.objectContaining({ stage: 'seed', growthMinutes: 0 }) as unknown,
        }) as unknown,
      });
      expect((await treeRow(ada)).stage).toBe('seed');
      expect((await current(ada)).stats.sessionCount).toBe(0);
    });

    it('recomputes the month from every stored counted session, and earns traits once', async () => {
      const ada = await t.signUp('ada@example.com');
      // 1–5 October: 2 h a day (stored directly), then 1 h through the API.
      await t.focus(
        ada,
        dateRange('2026-10-01', 5).map((date) => [date, 120] as [string, number]),
      );
      const body = await submitted(ada, '2026-10-07T10:00:00.000Z', 60);

      expect(body.growth).toMatchObject({
        stage: { from: 'seed', to: 'growing_tree' },
        newTraits: [
          { id: 'monthly-focus-hours:10', earnedAt: NOW },
          { id: 'streak-days:3', earnedAt: NOW },
        ],
      });
      expect(body.growth?.tree?.progress.growthMinutes).toBe(11 * 60);
      expect(await traitIds(ada)).toEqual(['monthly-focus-hours:10', 'streak-days:3']);

      // The next session earns nothing new and duplicates nothing.
      const next = await submitted(ada, '2026-10-07T12:00:00.000Z', 10);
      expect(next.growth?.newTraits).toEqual([]);
      expect(await traitIds(ada)).toEqual(['monthly-focus-hours:10', 'streak-days:3']);

      // A later milestone adds only itself next to the traits already earned.
      await t.focus(
        ada,
        dateRange('2026-10-08', 4).map((date) => [date, 220] as [string, number]),
      );
      await t.setNow('2026-10-12T20:00:00.000Z');
      const later = await submitted(ada, '2026-10-12T10:00:00.000Z', 60);
      expect(later.growth?.newTraits.map((trait) => trait.id)).toEqual(['monthly-focus-hours:25']);
      expect(await traitIds(ada)).toEqual([
        'monthly-focus-hours:10',
        'monthly-focus-hours:25',
        'streak-days:3',
      ]);
    });

    it('blooms from daily goals met', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.http().put('/me/goals/daily').set(ada.auth).send({ minutes: 30 }).expect(200);
      const body = await submitted(ada, '2026-10-07T10:00:00.000Z', 40);
      expect(body.growth?.blossoms).toEqual({ from: 0, to: 1 });
      expect((await current(ada)).stats.dailyGoalsMet).toBe(1);
    });

    it('never lowers what the tree has earned', async () => {
      const ada = await t.signUp('ada@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 5);
      // As if stricter rules had applied earlier: the stored tree is ahead of a recomputation.
      await t.prisma.monthlyTree.update({
        where: { userId_year_month: { userId: ada.userId, year: 2026, month: 10 } },
        data: { stage: 'final_form', fullnessLevel: 5, blossomLevel: 3, richnessTier: 2 },
      });
      const body = await submitted(ada, '2026-10-07T11:00:00.000Z', 10);
      expect(body.growth).not.toHaveProperty('stage');
      expect(body.growth?.tree?.progress).toMatchObject({
        stage: 'final_form',
        fullness: { level: 5 },
        blossoms: { level: 3 },
        richness: { tier: 2 },
      });
      expect(await treeRow(ada)).toMatchObject({
        stage: 'final_form',
        fullnessLevel: 5,
        blossomLevel: 3,
        richnessTier: 2,
      });
    });

    it('keeps one configuration version for a month’s tree; the next month uses the new one', async () => {
      const ada = await t.signUp('ada@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 5);
      const pinned = (await treeRow(ada)).configVersion;

      await t.activateConfig({ 'growth.stageThresholds': [1, 2, 3, 4, 5] });
      const october = await submitted(ada, '2026-10-07T11:00:00.000Z', 60);
      expect(october.growth?.tree?.configVersion).toBe(pinned);
      expect(october.growth?.tree?.progress.stage).toBe('sprout');

      await t.setNow('2026-11-02T20:00:00.000Z');
      const november = await submitted(ada, '2026-11-02T10:00:00.000Z', 10);
      expect(november.growth?.tree?.configVersion).toBeGreaterThan(pinned);
      expect(november.growth?.tree?.progress.stage).toBe('final_form');
    });
  });

  describe('replay', () => {
    it('returns the stored event, even after the tree and configuration changed', async () => {
      const ada = await t.signUp('ada@example.com');
      const id = randomUUID();
      const first = (await t.submit(ada, '2026-10-07T10:00:00.000Z', 5, id).expect(201))
        .body as SessionBody;

      await t.activateConfig({ 'growth.stageThresholds': [1, 2, 3, 4, 5] });
      await submitted(ada, '2026-10-07T11:00:00.000Z', 150);
      const before = await treeRow(ada);

      const again = await t.submit(ada, '2026-10-07T10:00:00.000Z', 5, id).expect(200);
      expect(again.body).toStrictEqual(first);
      expect(await treeRow(ada)).toEqual(before);
    });

    it('still refuses a different session under the same id', async () => {
      const ada = await t.signUp('ada@example.com');
      const id = randomUUID();
      await t.submit(ada, '2026-10-07T10:00:00.000Z', 5, id).expect(201);
      const res = await t.submit(ada, '2026-10-07T10:00:00.000Z', 6, id).expect(409);
      expect((res.body as { code: string }).code).toBe('session_id_conflict');
    });
  });

  describe('concurrency', () => {
    it('applies one session sent several times at once exactly once', async () => {
      const ada = await t.signUp('ada@example.com');
      const id = randomUUID();
      const responses = await Promise.all(
        [1, 2, 3].map(() => t.submit(ada, '2026-10-07T10:00:00.000Z', 30, id)),
      );
      expect(responses.map((res) => res.status).sort()).toEqual([200, 200, 201]);
      const growths = responses.map((res) => JSON.stringify((res.body as SessionBody).growth));
      expect(new Set(growths).size).toBe(1);
      expect(await t.prisma.focusSession.count()).toBe(1);
      expect((await current(ada)).tree.progress.growthMinutes).toBe(30);
    });

    it('applies two different sessions arriving together, losing none and earning a trait once', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(
        ada,
        ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map(
          (date) => [date, 118] as [string, number],
        ),
      );
      const responses = await Promise.all([
        t.submit(ada, '2026-10-07T10:00:00.000Z', 10),
        t.submit(ada, '2026-10-07T11:00:00.000Z', 10),
      ]);
      expect(responses.map((res) => res.status)).toEqual([201, 201]);
      const earnedBy = responses.filter((res) =>
        (res.body as SessionBody).growth?.newTraits.some(
          (trait) => trait.id === 'monthly-focus-hours:10',
        ),
      );
      expect(earnedBy).toHaveLength(1);
      expect(await traitIds(ada)).toEqual(['monthly-focus-hours:10', 'streak-days:3']);
      expect((await current(ada)).tree.progress.growthMinutes).toBe(5 * 118 + 20);
    });
  });

  describe('atomicity', () => {
    it('stores no session when the tree update fails', async () => {
      const ada = await t.signUp('ada@example.com');
      await current(ada); // the Seed exists
      await withFailure('monthly_trees', 'BEFORE UPDATE', async () => {
        await t.submit(ada, '2026-10-07T10:00:00.000Z', 30).expect(500);
      });
      expect(await t.prisma.focusSession.count()).toBe(0);
      expect((await treeRow(ada)).stage).toBe('seed');
    });

    it('stores no session and no tree change when a trait cannot be stored', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(
        ada,
        dateRange('2026-10-01', 5).map((date) => [date, 118] as [string, number]),
      );
      await withFailure('monthly_tree_traits', 'BEFORE INSERT', async () => {
        await t.submit(ada, '2026-10-07T10:00:00.000Z', 20).expect(500);
      });
      expect(
        await t.prisma.focusSession.count({ where: { localDate: new Date('2026-10-07') } }),
      ).toBe(0);
      expect(await t.prisma.monthlyTree.count()).toBe(0);
    });

    it('stores neither session nor tree when the growth result cannot be saved', async () => {
      const ada = await t.signUp('ada@example.com');
      await withFailure('focus_sessions', 'BEFORE UPDATE', async () => {
        await t.submit(ada, '2026-10-07T10:00:00.000Z', 30).expect(500);
      });
      expect(await t.prisma.focusSession.count()).toBe(0);
      expect(await t.prisma.monthlyTree.count()).toBe(0);
    });
  });

  describe('first month', () => {
    it('prorates a month the user joined late', async () => {
      const ada = await t.signUp('ada@example.com', 'UTC', '2026-10-16T09:00:00.000Z');
      await t.setNow('2026-10-16T20:00:00.000Z');
      expect((await current(ada)).tree.partialFirstMonth).toBe(true);
      // 16 of 31 days remain: Young Tree at ceil(2 h × 16 / 31) ≈ 61.9 min.
      const body = await submitted(ada, '2026-10-16T10:00:00.000Z', 62);
      expect(body.growth?.stage).toEqual({ from: 'seed', to: 'young_tree' });
      expect(await treeRow(ada)).toMatchObject({
        joinedOn: new Date('2026-10-16T00:00:00.000Z'),
        prorationNumerator: 16,
        prorationDenominator: 31,
      });

      await t.setNow('2026-11-02T20:00:00.000Z');
      expect((await current(ada)).tree.partialFirstMonth).toBe(false);
    });

    it('reads the join date in the month’s time zone', async () => {
      // 20:00 UTC on 1 October is 2 October in Ho Chi Minh City.
      const ada = await t.signUp('ada@example.com', 'Asia/Ho_Chi_Minh', '2026-10-01T20:00:00.000Z');
      const bob = await t.signUp('bob@example.com', 'UTC', '2026-10-01T20:00:00.000Z');
      expect((await current(ada)).tree.partialFirstMonth).toBe(true);
      expect((await current(bob)).tree.partialFirstMonth).toBe(false);
      expect(await treeRow(ada)).toMatchObject({
        prorationNumerator: 30,
        prorationDenominator: 31,
      });
    });
  });

  it('reads the join date in the month context’s time zone, not the current profile’s', async () => {
    // October's context is created in UTC by earlier focus; the tree only on a later view.
    const ada = await t.signUp('ada@example.com', 'UTC', '2026-10-01T20:00:00.000Z');
    await t.focus(ada, [['2026-10-02', 5]]);
    await t.http().patch('/me/profile').set(ada.auth).send({ timezone: 'Asia/Ho_Chi_Minh' });
    // In UTC the user joined on 1 October (a whole month); in Ho Chi Minh City on the 2nd.
    expect((await current(ada)).tree.partialFirstMonth).toBe(false);
  });

  it('keeps the month’s time zone when the profile time zone changes mid-month', async () => {
    const ada = await t.signUp('ada@example.com', 'Asia/Ho_Chi_Minh');
    await current(ada); // October's context: Ho Chi Minh City
    await t.http().patch('/me/profile').set(ada.auth).send({ timezone: 'America/Los_Angeles' });
    await t.setNow('2026-10-20T20:00:00.000Z');
    // 19:00 UTC on 20 October is 21 October in Ho Chi Minh City, 20 October in Los Angeles.
    const body = await submitted(ada, '2026-10-20T19:00:00.000Z', 30);
    expect(body).toMatchObject({ localDate: '2026-10-21', year: 2026, month: 10 });
    expect(body.growth?.tree).toMatchObject({ year: 2026, month: 10 });
    expect(await t.prisma.monthlyTree.count()).toBe(1);
  });

  describe('vitality', () => {
    it('follows the current date without changing anything earned', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-10-05', 30],
        ['2026-10-06', 30],
      ]);
      await submitted(ada, '2026-10-07T10:00:00.000Z', 30);
      const today = await current(ada);
      expect(today.tree.vitality).toBe('thriving');

      await t.setNow('2026-10-11T20:00:00.000Z');
      const later = await current(ada);
      expect(later.tree.vitality).toBe('quiet');
      expect(later.tree.progress).toEqual(today.tree.progress);
      expect(later.tree.traits).toEqual(today.tree.traits);
    });
  });

  it('does not count a recovered day as focus', async () => {
    const ada = await t.signUp('ada@example.com');
    await t.focus(
      ada,
      dateRange('2026-10-01', 4).map((date) => [date, 30] as [string, number]),
    );
    await t.setNow('2026-10-06T20:00:00.000Z');
    await submitted(ada, '2026-10-06T10:00:00.000Z', 30);
    await t
      .http()
      .post('/me/streak/recoveries')
      .set(ada.auth)
      .send({ missedDate: '2026-10-05' })
      .expect(201);
    const { stats, tree } = await current(ada);
    expect(stats).toMatchObject({ activeDays: 5, sessionCount: 5, focusedMinutes: 150 });
    expect(tree.progress.growthMinutes).toBe(150);
  });

  it('serves Home in one request: tree, goals, streak, and rest', async () => {
    const ada = await t.signUp('ada@example.com');
    await t.http().put('/me/rest-days/2026-10-07').set(ada.auth).expect(201);
    await submitted(ada, '2026-10-07T10:00:00.000Z', 20);
    const res = await t.http().get('/me/home').set(ada.auth).expect(200);
    expect(res.body).toMatchObject({
      today: '2026-10-07',
      tree: { year: 2026, month: 10, progress: { stage: 'sprout' } },
      goals: {
        daily: { minutes: 30, isDefault: true, today: { focusedMinutes: 20 } },
        weekly: { goal: null },
      },
      streak: { current: 0, today: 'rest' },
      rest: { today: true, allowance: { used: 1, remaining: 1 } },
    });
    expect(Object.keys(res.body as object).sort()).toEqual([
      'goals',
      'pendingCeremony',
      'recentTopics',
      'rest',
      'streak',
      'today',
      'tree',
    ]);
  });

  describe('reconciliation on read', () => {
    const blossomLevel = async (user: User) => (await current(user)).tree.progress.blossoms.level;

    it('blooms on read when the first daily goal is set after the focus that meets it', async () => {
      const ada = await t.signUp('ada@example.com');
      const id = randomUUID();
      const session = (await t.submit(ada, '2026-10-07T10:00:00.000Z', 40, id).expect(201))
        .body as SessionBody;
      expect(session.growth).not.toHaveProperty('blossoms');
      expect(await blossomLevel(ada)).toBe(0);

      await t.http().put('/me/goals/daily').set(ada.auth).send({ minutes: 30 }).expect(200);
      expect(await blossomLevel(ada)).toBe(1);
      expect((await treeRow(ada)).blossomLevel).toBe(1);
      const home = (await t.http().get('/me/home').set(ada.auth).expect(200)).body as {
        tree: TreeStateDto;
      };
      expect(home.tree.progress.blossoms.level).toBe(1);

      // No session was invented, and the stored event of the old session is unchanged.
      expect(await t.prisma.focusSession.count()).toBe(1);
      const replay = await t.submit(ada, '2026-10-07T10:00:00.000Z', 40, id).expect(200);
      expect(replay.body).toStrictEqual(session);
    });

    it('stores a streak milestone that an accepted recovery made valid, without a session', async () => {
      const ada = await t.signUp('ada@example.com');
      // 1–5 October, 6 October missed, back on the 7th and 8th: 5 + 2 days once repaired.
      await t.focus(
        ada,
        dateRange('2026-10-01', 5).map((date) => [date, 30] as [string, number]),
      );
      await submitted(ada, '2026-10-07T10:00:00.000Z', 30);
      await t.setNow('2026-10-08T20:00:00.000Z');
      await submitted(ada, '2026-10-08T10:00:00.000Z', 30);
      expect(await traitIds(ada)).toEqual(['streak-days:3']);

      await t
        .http()
        .post('/me/streak/recoveries')
        .set(ada.auth)
        .send({ missedDate: '2026-10-06' })
        .expect(201);
      const { tree } = await current(ada);
      expect(tree.traits.map((trait) => trait.id)).toEqual(['streak-days:3', 'streak-days:7']);
      const stored = await t.prisma.monthlyTreeTrait.findFirstOrThrow({
        where: { userId: ada.userId, traitId: 'streak-days:7' },
      });
      expect(stored).toMatchObject({
        sessionId: null,
        earnedAt: new Date('2026-10-08T20:00:00.000Z'),
      });
      expect(await t.prisma.focusSession.count()).toBe(7);
    });

    it('writes nothing when a read finds nothing new', async () => {
      const ada = await t.signUp('ada@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 40);
      await t.http().put('/me/goals/daily').set(ada.auth).send({ minutes: 30 }).expect(200);
      const first = await current(ada);
      const row = await treeRow(ada);
      const traits = await t.prisma.monthlyTreeTrait.findMany({ where: { userId: ada.userId } });

      await t.setNow('2026-10-07T21:00:00.000Z');
      const again = await current(ada);
      await t.http().get('/me/home').set(ada.auth).expect(200);
      expect(again.tree.progress).toEqual(first.tree.progress);
      expect(again.tree.traits).toEqual(first.tree.traits);
      expect(await treeRow(ada)).toEqual(row);
      expect(await t.prisma.monthlyTreeTrait.findMany({ where: { userId: ada.userId } })).toEqual(
        traits,
      );
    });

    it('reconciles once when reads arrive together', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(
        ada,
        dateRange('2026-10-01', 5).map((date) => [date, 30] as [string, number]),
      );
      await submitted(ada, '2026-10-07T10:00:00.000Z', 30);
      await t.setNow('2026-10-08T20:00:00.000Z');
      await submitted(ada, '2026-10-08T10:00:00.000Z', 30);
      await t.http().post('/me/streak/recoveries').set(ada.auth).send({ missedDate: '2026-10-06' });
      const responses = await Promise.all([
        t.http().get('/me/trees/current').set(ada.auth),
        t.http().get('/me/home').set(ada.auth),
        t.http().get('/me/trees/current').set(ada.auth),
      ]);
      expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
      expect(await traitIds(ada)).toEqual(['streak-days:3', 'streak-days:7']);
    });

    it('never reconciles an archived tree', async () => {
      const ada = await t.signUp('ada@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 40);
      await t.setNow('2026-11-02T10:00:00.000Z');
      await t.http().get('/me/home').set(ada.auth).expect(200); // archives October
      const before = await treeRow(ada);
      expect(before.status).toBe('archived');
      // October's stored truth changes after its archive: a late session.
      await t.submit(ada, '2026-10-20T10:00:00.000Z', 600).expect(201);
      await t.http().get('/me/trees/current').set(ada.auth).expect(200);
      await t.http().get('/me/home').set(ada.auth).expect(200);
      expect(await treeRow(ada)).toEqual(before);
    });
  });

  describe('Home recent topics', () => {
    interface RecentTopic {
      id: string;
      name: string;
      icon: string;
      color: string;
      lastUsedAt: string | null;
      lastPlannedMinutes: number | null;
    }
    const homeTopics = async (user: User) =>
      (
        (await t.http().get('/me/home').set(user.auth).expect(200)).body as {
          recentTopics: RecentTopic[];
        }
      ).recentTopics;
    const listed = async (user: User) =>
      (await t.http().get('/me/topics?status=active&sort=recent').set(user.auth).expect(200))
        .body as RecentTopic[];
    const createTopic = async (user: User, name: string) => {
      const id = randomUUID();
      await t
        .http()
        .put(`/me/topics/${id}`)
        .set(user.auth)
        .send({ name, icon: 'book', color: 'topic.2' })
        .expect(201);
      return { ...user, topicId: id };
    };

    it('lists the first recent active topics, in the Topics endpoint’s order', async () => {
      const ada = await t.signUp('ada@example.com');
      const names = ['Maths', 'Piano', 'French', 'Code', 'Chess', 'Art'];
      const topics = [ada];
      for (const name of names) topics.push(await createTopic(ada, name));
      // Uses at different times; some topics never used.
      await submitted(topics[2]!, '2026-10-07T08:00:00.000Z', 20);
      await submitted(topics[0]!, '2026-10-07T09:00:00.000Z', 25);
      await submitted(topics[4]!, '2026-10-07T10:00:00.000Z', 15);

      const home = await homeTopics(ada);
      expect(home).toHaveLength(5);
      expect(home).toEqual(
        (await listed(ada)).slice(0, 5).map((topic) => expect.objectContaining(topic) as unknown),
      );
      expect(home.slice(0, 3).map((topic) => topic.id)).toEqual([
        topics[4]!.topicId,
        topics[0]!.topicId,
        topics[2]!.topicId,
      ]);
      expect(home[0]).toMatchObject({
        name: 'Code',
        icon: 'book',
        color: 'topic.2',
        lastUsedAt: '2026-10-07T10:00:00.000Z',
        lastPlannedMinutes: 15,
      });
    });

    it('leaves archived topics out, and follows a newly synced session', async () => {
      const ada = await t.signUp('ada@example.com');
      const maths = await createTopic(ada, 'Maths');
      await submitted(ada, '2026-10-07T08:00:00.000Z', 20);
      await submitted(maths, '2026-10-07T09:00:00.000Z', 20);
      expect((await homeTopics(ada)).map((topic) => topic.id)).toEqual([
        maths.topicId,
        ada.topicId,
      ]);

      await submitted(ada, '2026-10-07T10:00:00.000Z', 20);
      expect((await homeTopics(ada)).map((topic) => topic.id)).toEqual([
        ada.topicId,
        maths.topicId,
      ]);

      await t.http().post(`/me/topics/${maths.topicId}/archive`).set(ada.auth).expect(200);
      expect((await homeTopics(ada)).map((topic) => topic.id)).toEqual([ada.topicId]);
    });

    it('shows only the user’s own topics', async () => {
      const ada = await t.signUp('ada@example.com');
      const bob = await t.signUp('bob@example.com');
      await submitted(bob, '2026-10-07T10:00:00.000Z', 20);
      expect((await homeTopics(ada)).map((topic) => topic.id)).toEqual([ada.topicId]);
      expect((await homeTopics(bob)).map((topic) => topic.id)).toEqual([bob.topicId]);
    });
  });
});
