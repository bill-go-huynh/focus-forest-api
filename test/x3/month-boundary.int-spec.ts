import { ConsistencyHarness, dateRange } from '../support/consistency-harness.js';
import { frozenMonth, get, MIN, sid, type X3User } from './x3-support.js';

/**
 * X3: the month boundary under load, and quiet months. Every meaningful request that arrives
 * together after the grace period sees one archive; a failed archive leaves nothing half done;
 * months without focus stay in the forest as resting months, across a year boundary.
 */

const t = new ConsistencyHarness('2026-09-30T20:00:00.000Z');

describe('X3 month boundary and quiet months (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-09-30T20:00:00.000Z');
    await t.activateConfig();
  });

  /** September with a week of daily focus (a streak trait), the tree viewed while growing. */
  async function september(email = 'ada@example.com') {
    const user = await t.signUp(email, 'UTC', '2026-09-01T00:00:00.000Z');
    await t.focus(
      user,
      dateRange('2026-09-21', 7).map((date) => [date, 60] as [string, number]),
    );
    await get(t, user, '/me/trees/current');
    return user;
  }

  const raceAfterGrace = (user: X3User) =>
    Promise.all([
      t.http().get('/me/home').set(user.auth),
      t.http().get('/me/forest').set(user.auth),
      t.http().get('/me/trees/current').set(user.auth),
      t.http().get('/me/trees/2026/9').set(user.auth),
      t.http().get('/me/trees/2026/9/recap').set(user.auth),
      t.http().get('/me/insights/month?year=2026&month=9').set(user.auth),
      t.http().put('/me/trees/2026/9/ceremony-seen').set(user.auth),
      t.submit(user, '2026-10-01T03:05:00.000Z', 20, sid(1)),
      t.submit(user, '2026-09-30T10:00:00.000Z', 15, sid(2)), // late, for September
    ]);

  it('archives once when every kind of request arrives together after the grace period', async () => {
    const user = await september();
    await t.setNow('2026-10-01T03:30:00.000Z');
    const responses = await raceAfterGrace(user);
    expect(responses.map((res) => res.status)).toEqual([
      200, 200, 200, 200, 200, 200, 200, 201, 201,
    ]);

    const archived = await frozenMonth(t, user.userId, 2026, 9);
    expect(archived.tree?.status).toBe('archived');
    expect(archived.closedAt).not.toBeNull();
    expect(await t.prisma.monthlyRecap.count({ where: { userId: user.userId } })).toBe(1);
    expect(
      await t.prisma.monthlyTree.count({ where: { userId: user.userId, year: 2026, month: 9 } }),
    ).toBe(1);
    // Everyone saw the same archive; nothing half frozen.
    const details = responses[3].body as {
      kind: string;
      archivedAt: string;
      tree: { traits: unknown[] };
    };
    expect(details.kind).toBe('archived');
    expect(archived.traits).toHaveLength(details.tree.traits.length);
    expect((responses[4].body as { generatedAt: string }).generatedAt).toBe(details.archivedAt);
    // The late session was kept without reopening the month; the new one grew October.
    const late = responses[8].body as { growth: { monthClosed: boolean; tree: unknown } };
    expect(late.growth).toMatchObject({ monthClosed: true, tree: null });
    const current = responses[7].body as { growth: { tree: { month: number } } };
    expect(current.growth.tree.month).toBe(10);
    expect((await get<{ tree: { month: number } }>(t, user, '/me/trees/current')).tree.month).toBe(
      10,
    );

    // Later reads change nothing: one closed_at, one archive.
    const again = await Promise.all([raceAfterGrace(user)]);
    expect(again[0].map((res) => res.status)).toEqual([
      200, 200, 200, 200, 200, 200, 200, 200, 200,
    ]);
    expect(await frozenMonth(t, user.userId, 2026, 9)).toEqual(archived);
  });

  it('never archives before the grace period has passed, whatever arrives', async () => {
    const user = await september();
    await t.setNow('2026-10-01T02:59:00.000Z');
    await Promise.all([
      t.http().get('/me/home').set(user.auth),
      t.http().get('/me/forest').set(user.auth),
      t.http().get('/me/trees/2026/9').set(user.auth),
      t.submit(user, '2026-09-30T10:00:00.000Z', 15, sid(3)),
    ]);
    const month = await frozenMonth(t, user.userId, 2026, 9);
    expect(month.tree?.status).toBe('growing');
    expect(month.closedAt).toBeNull();
    expect(month.recap).toBeNull();
  });

  it('leaves no half archive when the closure fails under concurrent requests, then archives once', async () => {
    const user = await september();
    await t.setNow('2026-10-01T03:30:00.000Z');
    await t.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION x3_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'failed on purpose'; END $$ LANGUAGE plpgsql`);
    await t.prisma.$executeRawUnsafe(
      'CREATE TRIGGER x3_fail BEFORE INSERT ON monthly_recaps FOR EACH ROW EXECUTE FUNCTION x3_fail()',
    );
    try {
      const failed = await Promise.all([
        t.http().get('/me/home').set(user.auth),
        t.http().get('/me/forest').set(user.auth),
        t.http().get('/me/trees/2026/9/recap').set(user.auth),
      ]);
      for (const res of failed) expect(res.status).toBe(500);
      const month = await frozenMonth(t, user.userId, 2026, 9);
      expect(month.tree?.status).toBe('growing');
      expect(month.tree?.archive ?? null).toBeNull();
      expect(month.closedAt).toBeNull();
      expect(month.recap).toBeNull();
    } finally {
      await t.prisma.$executeRawUnsafe('DROP TRIGGER x3_fail ON monthly_recaps');
    }
    await raceAfterGrace(user);
    expect((await frozenMonth(t, user.userId, 2026, 9)).tree?.status).toBe('archived');
    expect(await t.prisma.monthlyRecap.count({ where: { userId: user.userId } })).toBe(1);
  });

  it('keeps every quiet month in the forest across a year, and plants nothing for them', async () => {
    const user = await september();
    // October and December viewed; November never opened; December has discarded focus only.
    await t.setNow('2026-10-05T12:00:00.000Z');
    expect((await get<{ pendingCeremony: unknown }>(t, user, '/me/home')).pendingCeremony).toEqual({
      year: 2026,
      month: 9,
    });
    await t.setNow('2026-12-10T12:00:00.000Z');
    await get(t, user, '/me/home');
    await t.submit(user, '2026-12-10T08:00:00.000Z', 3, sid(10)).expect(201);
    // Back in February 2027.
    await t.setNow('2027-02-03T12:00:00.000Z');
    const home = await get<{ tree: { year: number; month: number }; pendingCeremony: unknown }>(
      t,
      user,
      '/me/home',
    );
    expect(home.tree).toMatchObject({ year: 2027, month: 2 });
    // September is still the latest month with focus: the ceremony offers it, never a quiet one.
    expect(home.pendingCeremony).toEqual({ year: 2026, month: 9 });

    const forest = await get<{
      items: { kind: string; year: number; month: number; focusedMilliseconds: number }[];
      progression: { treeCount: number };
      summary: { treeCount: number };
    }>(t, user, '/me/forest');
    expect(forest.items.map((i) => `${i.year}-${i.month}:${i.kind}`)).toEqual([
      '2027-2:growing',
      '2027-1:resting',
      '2026-12:resting',
      '2026-11:resting',
      '2026-10:resting',
      '2026-9:archived',
    ]);
    for (const item of forest.items.filter((i) => i.kind === 'resting')) {
      expect(item.focusedMilliseconds).toBe(0);
      expect(await get(t, user, `/me/trees/${item.year}/${item.month}`)).toEqual({
        kind: 'resting',
        year: item.year,
        month: item.month,
      });
    }
    // No archived Seed, no dead tree: quiet months hold no tree row and no recap.
    expect(
      (await t.prisma.monthlyTree.findMany({ where: { userId: user.userId } })).map(
        (tree) => `${tree.year}-${tree.month}:${tree.status}`,
      ),
    ).toEqual(expect.arrayContaining(['2026-9:archived', '2027-2:growing']));
    expect(await t.prisma.monthlyTree.count({ where: { userId: user.userId } })).toBe(2);
    expect(await t.prisma.monthlyRecap.count({ where: { userId: user.userId } })).toBe(1);
    await get(t, user, '/me/trees/2026/12/recap', 404);
    // Quiet months do not advance the forest; the discarded session stays in History.
    expect(forest.progression.treeCount).toBe(1);
    expect(forest.summary.treeCount).toBe(1);
    const december = await get<{ items: { counted: boolean; focusedMilliseconds: number }[] }>(
      t,
      user,
      '/me/sessions?month=2026-12',
    );
    expect(december.items).toEqual([expect.objectContaining({ counted: false })]);
    expect(december.items[0]!.focusedMilliseconds).toBe(3 * MIN);
  });
});
