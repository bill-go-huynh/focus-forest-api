import { randomUUID } from 'node:crypto';

import type { LocalDate } from '../../src/common/local-date.js';
import { AchievementsService } from '../../src/progression/achievements.service.js';
import { ConsistencyHarness, dateRange } from '../support/consistency-harness.js';

/**
 * A4.4.G: choosing a species reconciles first, in the selection's own transaction under the
 * user's row lock, so a user who already qualifies never needs an earlier progression read.
 * Nothing else changes: the Seed-only lock, the errors, and the race with the first session.
 */

const MIN = 60_000;
const NOW = '2026-10-07T20:00:00.000Z';
const t = new ConsistencyHarness(NOW);

type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

async function seed(user: User, rows: { date: LocalDate; minutes: number }[]): Promise<void> {
  for (const { date, minutes } of rows) {
    const [year = 0, month = 1] = date.split('-').map(Number);
    await t.prisma.monthAttributionContext.upsert({
      where: { userId_year_month: { userId: user.userId, year, month } },
      update: {},
      create: {
        userId: user.userId,
        year,
        month,
        timezone: 'UTC',
        startsAt: new Date(Date.UTC(year, month - 1, 1)),
        endsAt: new Date(Date.UTC(year, month, 1)),
      },
    });
    const startedAt = new Date(`${date}T08:00:00.000Z`);
    const endedAt = new Date(startedAt.getTime() + minutes * MIN);
    await t.prisma.focusSession.create({
      data: {
        id: randomUUID(),
        userId: user.userId,
        topicId: user.topicId,
        startedAt,
        submittedEndedAt: endedAt,
        plannedMinutes: Math.max(1, minutes),
        pauseIntervals: [],
        effectiveEndedAt: endedAt,
        focusedMilliseconds: minutes * MIN,
        pausedMilliseconds: 0,
        status: 'completed',
        localDate: new Date(`${date}T00:00:00.000Z`),
        year,
        month,
        configVersion: 4,
        createdAt: endedAt,
      },
    });
  }
}

/** September history that qualifies for Oak, Sakura, and Pine; nothing reconciled yet. */
async function qualified(email = 'ada@example.com'): Promise<User> {
  const user = await t.signUp(email, 'UTC', '2026-08-15T00:00:00.000Z');
  await seed(
    user,
    dateRange('2026-09-01', 7).map((date) => ({ date, minutes: 100 })),
  );
  return user;
}

const select = (user: User, speciesId: string) =>
  t.http().put('/me/trees/current/species').set(user.auth).send({ speciesId });
const ownedSpecies = async (userId: string) =>
  (await t.prisma.userSpecies.findMany({ where: { userId }, orderBy: { speciesId: 'asc' } })).map(
    (row) => row.speciesId,
  );
const tree = (userId: string, month: number) =>
  t.prisma.monthlyTree.findFirstOrThrow({ where: { userId, year: 2026, month } });

async function digest(tables: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of tables) {
    const [row] = await t.prisma.$queryRawUnsafe<{ md5: string | null }[]>(
      `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS md5 FROM "${table}" t`,
    );
    out[table] = row?.md5 ?? 'empty';
  }
  return out;
}

describe('A4.4.G species selection reconciles first (HTTP + PostgreSQL)', () => {
  let achievements: AchievementsService;

  beforeAll(async () => {
    await t.start();
    achievements = t.app.get(AchievementsService);
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow(NOW);
    await t.activateConfig();
  });

  it('selects Oak for a user who qualifies, without any progression read first', async () => {
    const ada = await qualified();
    expect(await ownedSpecies(ada.userId)).toEqual([]);
    const res = await select(ada, 'oak').expect(200);
    expect((res.body as { tree: { species: string } }).tree.species).toBe('oak');
    expect((await tree(ada.userId, 10)).species).toBe('oak');
  });

  it('selects Sakura the same way', async () => {
    const ada = await qualified();
    await select(ada, 'sakura').expect(200);
    expect((await tree(ada.userId, 10)).species).toBe('sakura');
    expect(await ownedSpecies(ada.userId)).toEqual(['oak', 'pine', 'sakura']);
  });

  it('still refuses a species the user does not qualify for, or one that cannot be chosen', async () => {
    const ada = await qualified();
    expect((await select(ada, 'maple').expect(422)).body).toMatchObject({
      code: 'species_not_owned',
    });
    const bob = await t.signUp('bob@example.com');
    expect((await select(bob, 'oak').expect(422)).body).toMatchObject({
      code: 'species_not_owned',
    });
    // A refused selection is atomic: its reconciliation grants roll back with it.
    expect(await ownedSpecies(ada.userId)).toEqual([]);
    await select(ada, 'oak').expect(200);
    expect(await ownedSpecies(ada.userId)).toEqual(['oak', 'pine', 'sakura']);
    await t.prisma.treeSpecies.update({ where: { id: 'pine' }, data: { status: 'retired' } });
    expect((await select(ada, 'pine').expect(422)).body).toMatchObject({
      code: 'species_not_selectable',
    });
  });

  it('never duplicates ownership, repeated or racing reconciliation', async () => {
    const ada = await qualified();
    await select(ada, 'oak').expect(200);
    await select(ada, 'oak').expect(200);
    const results = await Promise.all([
      select(ada, 'pine'),
      select(ada, 'sakura'),
      achievements.reconcile(ada.userId),
      t.http().get('/me/collection').set(ada.auth),
    ]);
    expect(results.slice(0, 2).map((r) => (r as { status: number }).status)).toEqual([200, 200]);
    expect(await ownedSpecies(ada.userId)).toEqual(['oak', 'pine', 'sakura']);
    expect(await t.prisma.userBadge.count({ where: { userId: ada.userId } })).toBe(4);
  });

  it('keeps the Seed-only lock: a discarded session does not lock, a counted one does', async () => {
    const ada = await qualified();
    await select(ada, 'oak').expect(200);
    const discarded = await t.submit(ada, '2026-10-07T10:00:00.000Z', 3).expect(201);
    expect((discarded.body as { counted: boolean }).counted).toBe(false);
    await select(ada, 'sakura').expect(200);
    const counted = await t.submit(ada, '2026-10-07T11:00:00.000Z', 30).expect(201);
    expect((counted.body as { growth: { tree: { species: string } } }).growth.tree.species).toBe(
      'sakura',
    );
    expect((await select(ada, 'pine').expect(409)).body).toMatchObject({ code: 'species_locked' });
  });

  it('ends with one frozen species whatever wins the race with the first session', async () => {
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']) {
      const user = await qualified(email);
      await t.http().get('/me/trees/current').set(user.auth).expect(200);
      const [selection, session] = await Promise.all([
        select(user, 'oak'),
        t.submit(user, '2026-10-07T10:00:00.000Z', 30),
      ]);
      const stored = await tree(user.userId, 10);
      expect((session.body as { growth: { tree: { species: string } } }).growth.tree.species).toBe(
        stored.species,
      );
      if (selection.status === 200) expect(stored.species).toBe('oak');
      else {
        expect(selection.status).toBe(409);
        expect(stored.species).toBe('signature');
      }
    }
  });

  it('keeps users apart', async () => {
    const ada = await qualified('ada@example.com');
    const bob = await t.signUp('bob@example.com');
    await select(ada, 'oak').expect(200);
    await select(bob, 'oak').expect(422);
    expect(await ownedSpecies(bob.userId)).toEqual([]);
    expect(await t.prisma.userBadge.count({ where: { userId: bob.userId } })).toBe(0);
  });

  it('changes no history, archive, or recap, and reports no unlock as new', async () => {
    const ada = await qualified();
    // Resolving the current tree (as Home does) closes September first: measure from here.
    await t.http().get('/me/trees/current').set(ada.auth).expect(200);
    const september = await tree(ada.userId, 9);
    const tables = [
      'focus_sessions',
      'monthly_recaps',
      'monthly_tree_traits',
      'month_attribution_contexts',
      'streak_recoveries',
      'rest_days',
      'user_equipment',
    ];
    const before = await digest(tables);
    const october = await tree(ada.userId, 10);
    await select(ada, 'oak').expect(200);
    expect(await digest(tables)).toEqual(before);
    expect(await tree(ada.userId, 9)).toEqual(september);
    expect({
      ...(await tree(ada.userId, 10)),
      species: october.species,
      updatedAt: october.updatedAt,
    }).toEqual(october);
    const session = await t.submit(ada, '2026-10-07T10:00:00.000Z', 20).expect(201);
    expect((session.body as { progression: unknown }).progression).toEqual({
      newlyEarnedBadges: [],
      newlyUnlockedSpecies: [],
      newlyUnlockedCosmetics: [],
    });
  });
});
