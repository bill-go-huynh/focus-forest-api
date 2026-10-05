import { randomUUID } from 'node:crypto';

import type { TreeStateDto } from '../../src/trees/tree.contracts.js';
import { ConsistencyHarness, dateRange } from '../support/consistency-harness.js';
import { CURRENT_CONFIG_VALUES } from '../support/product-config-values.js';

// Wednesday 7 October 2026, 20:00 UTC.
const NOW = '2026-10-07T20:00:00.000Z';
const t = new ConsistencyHarness(NOW);

type User = Awaited<ReturnType<typeof t.signUp>>;

interface SessionBody {
  id: string;
  growth: unknown;
  [field: string]: unknown;
}

interface ArchivedDetails {
  kind: 'archived';
  year: number;
  month: number;
  archivedAt: string;
  tree: TreeStateDto;
  stats: Record<string, unknown>;
  highlightedNotes: unknown[];
  badges: unknown[];
  events: unknown[];
}

describe('month closure (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow(NOW);
    await t.activateConfig();
  });

  const get = async <T = Record<string, unknown>>(user: User, path: string, status = 200) =>
    (await t.http().get(path).set(user.auth).expect(status)).body as T;
  const put = async <T = Record<string, unknown>>(user: User, path: string, status = 200) =>
    (await t.http().put(path).set(user.auth).expect(status)).body as T;
  const submitted = async (user: User, startedAt: string, minutes: number, id?: string) =>
    (await t.submit(user, startedAt, minutes, id).expect(201)).body as SessionBody;
  const treeRow = (user: User, month: number, year = 2026) =>
    t.prisma.monthlyTree.findUnique({
      where: { userId_year_month: { userId: user.userId, year, month } },
    });
  const statusOf = async (user: User, month: number, year = 2026) =>
    (await treeRow(user, month, year))?.status ?? null;
  /** Everything an archive holds, to compare before and after. */
  const frozen = async (user: User, month: number, year = 2026) => {
    const key = { userId_year_month: { userId: user.userId, year, month } };
    return {
      tree: await t.prisma.monthlyTree.findUnique({ where: key }),
      traits: await t.prisma.monthlyTreeTrait.findMany({
        where: { userId: user.userId, year, month },
        orderBy: { traitId: 'asc' },
      }),
      recap: await t.prisma.monthlyRecap.findUnique({ where: key }),
      context: await t.prisma.monthAttributionContext.findUnique({ where: key }),
    };
  };

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

  describe('eligibility', () => {
    it('keeps a month growing until its end plus the grace period, and archives it then', async () => {
      const ada = await t.signUp('ada@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 30);

      await t.setNow('2026-10-31T23:59:59.999Z');
      await get(ada, '/me/home');
      expect(await statusOf(ada, 10)).toBe('growing');

      // The month has ended; its 3-hour grace has not.
      await t.setNow('2026-11-01T02:59:59.999Z');
      await get(ada, '/me/home');
      await get(ada, '/me/forest');
      expect(await statusOf(ada, 10)).toBe('growing');

      await t.setNow('2026-11-01T03:00:00.000Z');
      await get(ada, '/me/trees/current');
      expect(await treeRow(ada, 10)).toMatchObject({
        status: 'archived',
        archivedAt: new Date('2026-11-01T03:00:00.000Z'),
      });
    });

    it('takes the end from the month’s own time zone, not the profile’s, over a DST change', async () => {
      // November in New York: 1 November 04:00 UTC (EDT) to 1 December 05:00 UTC (EST).
      await t.setNow('2026-11-10T20:00:00.000Z');
      const ada = await t.signUp('ada@example.com', 'America/New_York');
      await submitted(ada, '2026-11-10T15:00:00.000Z', 30);
      // In Tokyo, November would have ended at 30 November 15:00 UTC.
      await t
        .http()
        .patch('/me/profile')
        .set(ada.auth)
        .send({ timezone: 'Asia/Tokyo' })
        .expect(200);

      await t.setNow('2026-12-01T07:59:59.999Z');
      await get(ada, '/me/home');
      expect(await statusOf(ada, 11)).toBe('growing');

      await t.setNow('2026-12-01T08:00:00.000Z');
      await get(ada, '/me/home');
      expect(await statusOf(ada, 11)).toBe('archived');
      const { tree } = await get<ArchivedDetails>(ada, '/me/trees/2026/11');
      expect(tree.status).toBe('archived');
    });

    it('closes December into the next year', async () => {
      await t.setNow('2026-12-15T10:00:00.000Z');
      const ada = await t.signUp('ada@example.com', 'Asia/Ho_Chi_Minh');
      await submitted(ada, '2026-12-15T02:00:00.000Z', 30);

      // December in Ho Chi Minh City ends on 31 December at 17:00 UTC.
      await t.setNow('2026-12-31T19:59:59.999Z');
      await get(ada, '/me/home');
      expect(await statusOf(ada, 12)).toBe('growing');

      await t.setNow('2026-12-31T20:00:00.000Z');
      const home = await get<{ tree: TreeStateDto }>(ada, '/me/home');
      expect(await statusOf(ada, 12)).toBe('archived');
      expect(home.tree).toMatchObject({ year: 2027, month: 1, status: 'growing' });
    });

    it('uses the configured grace period', async () => {
      await t.activateConfig({ 'session.monthGraceMinutes': 0 });
      const ada = await t.signUp('ada@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 30);
      await t.setNow('2026-11-01T00:00:00.000Z');
      await get(ada, '/me/home');
      expect(await statusOf(ada, 10)).toBe('archived');
    });
  });

  describe('transaction and concurrency', () => {
    it('archives a month exactly once when Home, Forest, and a session arrive together', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(
        ada,
        dateRange('2026-10-01', 6).map((date) => [date, 60] as [string, number]),
      );
      await t.setNow('2026-11-02T10:00:00.000Z');
      const responses = await Promise.all([
        t.http().get('/me/home').set(ada.auth),
        t.http().get('/me/forest').set(ada.auth),
        t.submit(ada, '2026-11-02T08:00:00.000Z', 30),
        t.http().get('/me/trees/current').set(ada.auth),
        t.http().get('/me/trees/2026/10').set(ada.auth),
        t.http().get('/me/forest').set(ada.auth),
      ]);
      expect(responses.map((res) => res.status)).toEqual([200, 200, 201, 200, 200, 200]);
      expect(await t.prisma.monthlyRecap.count()).toBe(1);
      expect(await treeRow(ada, 10)).toMatchObject({
        status: 'archived',
        archivedAt: new Date('2026-11-02T10:00:00.000Z'),
      });
    });

    it('archives nothing when any step of the closure fails', async () => {
      const ada = await t.signUp('ada@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 30);
      await t.setNow('2026-11-02T10:00:00.000Z');
      await withFailure('monthly_recaps', 'BEFORE INSERT', async () => {
        await t.http().get('/me/trees/current').set(ada.auth).expect(500);
      });
      expect(await statusOf(ada, 10)).toBe('growing');
      expect((await frozen(ada, 10)).context?.closedAt).toBeNull();

      await get(ada, '/me/trees/current');
      expect(await statusOf(ada, 10)).toBe('archived');
    });
  });

  describe('archived snapshot', () => {
    it('freezes the tree and the month’s stats, without vitality', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.http().put('/me/goals/daily').set(ada.auth).send({ minutes: 30 }).expect(200);
      await t.focus(
        ada,
        dateRange('2026-10-01', 5).map((date) => [date, 90] as [string, number]),
      );
      await submitted(ada, '2026-10-07T10:00:00.000Z', 45);
      const growing = await get<{ tree: TreeStateDto }>(ada, '/me/trees/current');
      expect(growing.tree.vitality).not.toBeNull();

      await t.setNow('2026-11-02T10:00:00.000Z');
      const details = await get<ArchivedDetails>(ada, '/me/trees/2026/10');
      expect(details).toEqual({
        kind: 'archived',
        year: 2026,
        month: 10,
        archivedAt: '2026-11-02T10:00:00.000Z',
        tree: { ...growing.tree, status: 'archived', vitality: null },
        stats: {
          focusedMinutes: 5 * 90 + 45,
          sessionCount: 6,
          activeDays: 6,
          dailyGoalsMet: 1, // the first daily goal applies from 7 October
          weeklyGoalsMet: 0,
          longestStreak: 5,
          topTopic: { id: ada.topicId, name: 'Reading', icon: 'book', color: 'topic.1' },
        },
        highlightedNotes: [],
        // A4.2: the badges earned in October, snapshot at archive. First Session was reached by
        // sessions stored directly (as before A4.2): dated at the crossing session's stored
        // created_at (the database clock here, not the test clock), so only its id is pinned.
        badges: [
          expect.objectContaining({ id: 'first-session', category: 'focus' }) as unknown,
          expect.objectContaining({
            id: 'focus-streak:3',
            earnedAt: '2026-10-07T20:00:00.000Z',
          }) as unknown,
        ],
        events: [],
      });
    });

    it('never changes after archive, whatever changes later', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(
        ada,
        dateRange('2026-10-01', 7).map((date) => [date, 120] as [string, number]),
      );
      await t.setNow('2026-11-02T10:00:00.000Z');
      const details = await get(ada, '/me/trees/2026/10');
      const recap = await get(ada, '/me/trees/2026/10/recap');
      const stored = await frozen(ada, 10);

      await t.activateConfig({
        'growth.stageThresholds': [1, 2, 3, 4, 5],
        'growth.fullnessLevels': [1, 2, 3],
        'vitality.rules': { thrivingActiveRunDays: 1, healthyWithinDays: 5, stableWithinDays: 9 },
        'session.monthGraceMinutes': 600,
      });
      await t
        .http()
        .patch(`/me/topics/${ada.topicId}`)
        .set(ada.auth)
        .send({ name: 'Renamed' })
        .expect(200);
      await t.http().put('/me/goals/daily').set(ada.auth).send({ minutes: 10 }).expect(200);
      await get(ada, '/me/forest');

      expect(await get(ada, '/me/trees/2026/10')).toEqual(details);
      expect(await get(ada, '/me/trees/2026/10/recap')).toEqual(recap);
      expect(await frozen(ada, 10)).toEqual(stored);
    });

    it('brings the tree up to date once before freezing it', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.setNow('2026-10-31T20:00:00.000Z');
      await submitted(ada, '2026-10-31T10:00:00.000Z', 40);
      // The first daily goal applies today, after the focus that meets it; nothing reads the tree.
      await t.http().put('/me/goals/daily').set(ada.auth).send({ minutes: 30 }).expect(200);

      await t.setNow('2026-11-02T10:00:00.000Z');
      await get(ada, '/me/forest');
      expect(await treeRow(ada, 10)).toMatchObject({ status: 'archived', blossomLevel: 1 });
      const details = await get<ArchivedDetails>(ada, '/me/trees/2026/10');
      expect(details.tree.progress.blossoms.level).toBe(1);
      expect(details.stats['dailyGoalsMet']).toBe(1);
    });

    it('archives a tree pinned to an older configuration version under a newer one', async () => {
      // A version from before the month-closure keys, active when October's tree was created.
      const older = Object.fromEntries(
        Object.entries(CURRENT_CONFIG_VALUES).filter(
          ([key]) => !key.startsWith('forest.') && key !== 'session.monthGraceMinutes',
        ),
      );
      const [row] = await t.prisma.$queryRaw<{ version: number }[]>`
        INSERT INTO product_config_versions (values, note)
        VALUES (${JSON.stringify(older)}::jsonb, 'before month closure') RETURNING version`;
      const pinned = row?.version ?? 0;
      const ada = await t.signUp('ada@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 150);
      // As if October's tree had been created while that version was active.
      await t.prisma.monthlyTree.update({
        where: { userId_year_month: { userId: ada.userId, year: 2026, month: 10 } },
        data: { configVersion: pinned },
      });

      await t.activateConfig({ 'growth.stageThresholds': [1, 2, 3, 4, 5] });
      await t.setNow('2026-11-02T10:00:00.000Z');
      const details = await get<ArchivedDetails>(ada, '/me/trees/2026/10');
      expect(details.tree).toMatchObject({
        status: 'archived',
        configVersion: pinned,
        progress: { stage: 'young_tree', growthMinutes: 150 },
      });
    });
  });

  describe('quiet months', () => {
    it('rests a month that was viewed but never focused, instead of keeping a Seed', async () => {
      const ada = await t.signUp('ada@example.com');
      await get(ada, '/me/trees/current'); // October's Seed
      await t.setNow('2026-11-02T10:00:00.000Z');
      await get(ada, '/me/home');

      expect(await treeRow(ada, 10)).toBeNull();
      expect((await frozen(ada, 10)).context?.closedAt).toEqual(
        new Date('2026-11-02T10:00:00.000Z'),
      );
      expect(await get(ada, '/me/trees/2026/10')).toEqual({
        kind: 'resting',
        year: 2026,
        month: 10,
      });
      await get(ada, '/me/trees/2026/10/recap', 404);
      await put(ada, '/me/trees/2026/10/ceremony-seen', 404);
    });

    it('rests a month whose only sessions were discarded', async () => {
      const ada = await t.signUp('ada@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 2);
      await t.setNow('2026-11-02T10:00:00.000Z');
      await get(ada, '/me/home');
      expect(await treeRow(ada, 10)).toBeNull();
      expect(await t.prisma.monthlyRecap.count()).toBe(0);
    });
  });

  describe('late sessions', () => {
    async function archivedOctober() {
      const ada = await t.signUp('ada@example.com');
      await t.focus(
        ada,
        dateRange('2026-10-01', 4).map((date) => [date, 60] as [string, number]),
      );
      await t.setNow('2026-11-02T10:00:00.000Z');
      await get(ada, '/me/home');
      expect(await statusOf(ada, 10)).toBe('archived');
      return ada;
    }

    it('stores a counted session of an archived month without touching its tree or recap', async () => {
      const ada = await archivedOctober();
      const before = await frozen(ada, 10);
      const details = await get(ada, '/me/trees/2026/10');
      const recap = await get(ada, '/me/trees/2026/10/recap');
      const lifetime = (
        await get<{ summary: { lifetimeFocusedMinutes: number } }>(ada, '/me/forest')
      ).summary.lifetimeFocusedMinutes;

      const id = randomUUID();
      const body = await submitted(ada, '2026-10-20T10:00:00.000Z', 30, id);
      expect(body).toMatchObject({ id, status: 'completed', counted: true, year: 2026, month: 10 });
      expect(body.growth).toEqual({ counted: true, monthClosed: true, newTraits: [], tree: null });

      expect(await frozen(ada, 10)).toEqual(before);
      expect(await get(ada, '/me/trees/2026/10')).toEqual(details);
      expect(await get(ada, '/me/trees/2026/10/recap')).toEqual(recap);
      const history = await get<{ items: { id: string }[] }>(ada, '/me/sessions');
      expect(history.items.map((item) => item.id)).toContain(id);
      expect(
        (await get<{ summary: { lifetimeFocusedMinutes: number } }>(ada, '/me/forest')).summary
          .lifetimeFocusedMinutes,
      ).toBe(lifetime + 30);

      // A replay answers the same, even after a configuration change.
      await t.activateConfig({ 'growth.stageThresholds': [1, 2, 3, 4, 5] });
      const again = await t.submit(ada, '2026-10-20T10:00:00.000Z', 30, id).expect(200);
      expect(again.body).toStrictEqual(body);
      expect(await frozen(ada, 10)).toEqual(before);
    });

    it('stores a discarded late session the same way', async () => {
      const ada = await archivedOctober();
      const before = await frozen(ada, 10);
      const body = await submitted(ada, '2026-10-20T10:00:00.000Z', 2);
      expect(body.growth).toEqual({ counted: false, monthClosed: true, newTraits: [], tree: null });
      expect(await frozen(ada, 10)).toEqual(before);
    });

    it('still refuses a late session that overlaps a stored one', async () => {
      const ada = await archivedOctober();
      // 1 October, 08:00–09:00 is stored.
      const res = await t.submit(ada, '2026-10-01T08:30:00.000Z', 30).expect(409);
      expect((res.body as { code: string }).code).toBe('session_overlap');
    });

    it('never plants a tree for a quiet or an absent month', async () => {
      const ada = await t.signUp('ada@example.com');
      await get(ada, '/me/home'); // October viewed, never focused
      await t.setNow('2026-11-02T10:00:00.000Z');
      await get(ada, '/me/home');

      const october = await submitted(ada, '2026-10-20T10:00:00.000Z', 30);
      expect(october.growth).toMatchObject({ counted: true, monthClosed: true, tree: null });
      // September had no context at all.
      const september = await submitted(ada, '2026-09-20T10:00:00.000Z', 30);
      expect(september.growth).toMatchObject({ counted: true, monthClosed: true, tree: null });

      expect(await treeRow(ada, 10)).toBeNull();
      expect(await treeRow(ada, 9)).toBeNull();
      expect((await frozen(ada, 9)).context?.closedAt).not.toBeNull();
      expect(await get(ada, '/me/trees/2026/9')).toEqual({ kind: 'resting', year: 2026, month: 9 });
    });

    it('grows a past month that is still within its grace period', async () => {
      const ada = await t.signUp('ada@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 30);
      await t.setNow('2026-11-01T01:00:00.000Z');
      const body = await submitted(ada, '2026-10-31T23:00:00.000Z', 30);
      expect(body.growth).toMatchObject({ counted: true, monthClosed: false });
      expect((await treeRow(ada, 10))?.status).toBe('growing');
    });
  });

  describe('month-end ceremony', () => {
    it('offers the latest archived month once, until it is seen', async () => {
      const ada = await t.signUp('ada@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 30);
      expect((await get(ada, '/me/home'))['pendingCeremony']).toBeNull();

      await t.setNow('2026-11-02T10:00:00.000Z');
      expect((await get(ada, '/me/home'))['pendingCeremony']).toEqual({ year: 2026, month: 10 });
      const recap = await get(ada, '/me/trees/2026/10/recap');
      expect(recap).toMatchObject({ ceremonySeenAt: null, recapSeenAt: null });

      expect(await put(ada, '/me/trees/2026/10/ceremony-seen')).toEqual({
        ceremonySeenAt: '2026-11-02T10:00:00.000Z',
        recapSeenAt: null,
      });
      await t.setNow('2026-11-03T10:00:00.000Z');
      expect(await put(ada, '/me/trees/2026/10/ceremony-seen')).toEqual({
        ceremonySeenAt: '2026-11-02T10:00:00.000Z',
        recapSeenAt: null,
      });
      expect((await get(ada, '/me/home'))['pendingCeremony']).toBeNull();

      expect(await put(ada, '/me/trees/2026/10/recap-seen')).toEqual({
        ceremonySeenAt: '2026-11-02T10:00:00.000Z',
        recapSeenAt: '2026-11-03T10:00:00.000Z',
      });
      await put(ada, '/me/trees/2026/10/recap-seen');
      const seen = await get(ada, '/me/trees/2026/10/recap');
      expect({ ...seen, ceremonySeenAt: null, recapSeenAt: null }).toEqual(recap);
    });

    it('after months away, offers only the latest month with focus', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-08-10', 30],
        ['2026-09-10', 30],
      ]);
      // October passes without focus; the user comes back in November.
      await t.setNow('2026-11-05T10:00:00.000Z');
      expect((await get(ada, '/me/home'))['pendingCeremony']).toEqual({ year: 2026, month: 9 });
      expect(await statusOf(ada, 8)).toBe('archived');
      await put(ada, '/me/trees/2026/9/ceremony-seen');
      expect((await get(ada, '/me/home'))['pendingCeremony']).toBeNull();
    });

    it('keeps seen state per user, for archived months only', async () => {
      const ada = await t.signUp('ada@example.com');
      const bob = await t.signUp('bob@example.com');
      await submitted(ada, '2026-10-07T10:00:00.000Z', 30);
      await put(ada, '/me/trees/2026/10/ceremony-seen', 404); // still growing
      await t.setNow('2026-11-02T10:00:00.000Z');
      await put(bob, '/me/trees/2026/10/ceremony-seen', 404);
      await get(bob, '/me/trees/2026/10/recap', 404);
      expect((await get(ada, '/me/home'))['pendingCeremony']).toEqual({ year: 2026, month: 10 });
    });
  });
});
