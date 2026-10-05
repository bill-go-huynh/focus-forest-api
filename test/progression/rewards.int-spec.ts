import { randomUUID } from 'node:crypto';

import { addDays, type LocalDate } from '../../src/common/local-date.js';
import type { FocusSessionStatus } from '../../src/generated/prisma/client.js';
import { AchievementsService } from '../../src/progression/achievements.service.js';
import { ConsistencyHarness, dateRange } from '../support/consistency-harness.js';

/**
 * A4.3 species, variants, cosmetics, and equipment (HTTP + PostgreSQL): rewards linked to an
 * achievement are granted with its badge by the one evaluator, reported once by the action that
 * caused them, and reconciled for owners from before A4.3. Species is chosen for the current
 * month while its tree is a Seed and frozen by the first counted session. Equipment is user
 * presentation state, apart from ownership, trees, and recaps.
 */

const MIN = 60_000;
const NOW = '2026-10-07T20:00:00.000Z';
const t = new ConsistencyHarness(NOW);

type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

interface Named {
  id: string;
  [key: string]: unknown;
}
interface Progression {
  newlyEarnedBadges: Named[];
  newlyUnlockedSpecies: Named[];
  newlyUnlockedCosmetics: Named[];
}
interface Submitted {
  status: string;
  counted: boolean;
  growth: { tree: { species: string; progress: unknown } | null } | null;
  progression: Progression | null;
}
interface SpeciesBody {
  items: {
    id: string;
    name: string;
    description: string;
    rarity: string;
    baseSpeciesId: string | null;
    selectable: boolean;
  }[];
  current: { year: number; month: number; speciesId: string; locked: boolean };
}
interface CosmeticsBody {
  items: { id: string; type: string; rarity: string; artworkId: string; equipped: boolean }[];
}
interface EquipmentBody {
  forest: Record<string, Named | null>;
  profileFrame: Named | null;
}
interface TreeBody {
  tree: { species: string; progress: unknown };
}

async function seed(
  user: User,
  rows: { date: LocalDate; minutes: number; status?: FocusSessionStatus }[],
): Promise<void> {
  for (const { date, minutes, status = 'completed' } of rows) {
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
        status,
        localDate: new Date(`${date}T00:00:00.000Z`),
        year,
        month,
        configVersion: 4,
        createdAt: endedAt,
      },
    });
  }
}

const submit = async (user: User, startedAt: string, minutes: number, id = randomUUID()) => {
  const res = await t.submit(user, startedAt, minutes, id);
  return { status: res.status, body: res.body as Submitted };
};
const get = async <T>(user: User, path: string, status = 200) =>
  (await t.http().get(path).set(user.auth).expect(status)).body as T;
const select = (user: User, speciesId: unknown) =>
  t.http().put('/me/trees/current/species').set(user.auth).send({ speciesId });
const equip = (user: User, slot: string, cosmeticId: unknown) =>
  t.http().put(`/me/equipment/${slot}`).set(user.auth).send({ cosmeticId });
const unequip = (user: User, slot: string) =>
  t.http().delete(`/me/equipment/${slot}`).set(user.auth);
const ids = (items: { id: string }[] | undefined) => (items ?? []).map((item) => item.id);
const ownedSpecies = async (userId: string) =>
  (await t.prisma.userSpecies.findMany({ where: { userId }, orderBy: { speciesId: 'asc' } })).map(
    (row) => row.speciesId,
  );
const ownedCosmetics = async (userId: string) =>
  (await t.prisma.userCosmetic.findMany({ where: { userId }, orderBy: { cosmeticId: 'asc' } })).map(
    (row) => row.cosmeticId,
  );

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
const CORE = [
  'focus_sessions',
  'monthly_trees',
  'monthly_tree_traits',
  'monthly_recaps',
  'month_attribution_contexts',
  'streak_recoveries',
  'rest_days',
];

/** September history (First Session, 10 hours, 7-day streak), October not started. */
async function septemberUser(email = 'ada@example.com'): Promise<User> {
  const user = await t.signUp(email, 'UTC', '2026-08-15T00:00:00.000Z');
  await seed(
    user,
    dateRange('2026-09-01', 7).map((date) => ({ date, minutes: 100 })),
  );
  await get(user, '/me/species');
  return user;
}

describe('A4.3 species, cosmetics, and equipment (HTTP + PostgreSQL)', () => {
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

  describe('catalog', () => {
    it('seeds the species with their achievements, variants on their base, no Moon or Crystal tree', async () => {
      const species = await t.prisma.treeSpecies.findMany({
        include: { achievement: true },
        orderBy: { sortOrder: 'asc' },
      });
      expect(
        species.map((s) => [s.id, s.source, s.achievementId, s.baseSpeciesId, s.status, s.rarity]),
      ).toEqual([
        ['signature', 'system', null, null, 'active', 'common'],
        ['oak', 'achievement', 'first-session', null, 'active', 'common'],
        ['sakura', 'achievement', 'focus-hours:10', null, 'active', 'common'],
        ['pine', 'achievement', 'focus-streak:7', null, 'active', 'common'],
        ['maple', 'achievement', 'focus-hours:50', null, 'active', 'common'],
        ['bonsai', 'achievement', 'focus-streak:30', null, 'active', 'rare'],
        ['fantasy', 'achievement', 'focus-hours:100', null, 'active', 'rare'],
        ['golden-sakura', 'achievement', 'focus-hours:500', 'sakura', 'active', 'legendary'],
        ['ancient-pine', 'achievement', 'focus-streak:100', 'pine', 'active', 'legendary'],
      ]);
    });

    it('seeds a small cosmetic catalog: two defaults and three achievement rewards', async () => {
      const cosmetics = await t.prisma.cosmeticDefinition.findMany({
        orderBy: { sortOrder: 'asc' },
      });
      expect(cosmetics.map((c) => [c.id, c.type, c.source, c.achievementId])).toEqual([
        ['meadow', 'background', 'system', null],
        ['mossy-stones', 'decoration', 'system', null],
        ['stone-lantern', 'decoration', 'achievement', 'focus-hours:50'],
        ['misty-hills', 'background', 'achievement', 'focus-hours:100'],
        ['twig-frame', 'profile_frame', 'achievement', 'focus-streak:30'],
      ]);
      // Nothing that imitates an earned layer of the tree (blossoms, fruit, glow, fauna).
      expect(cosmetics.some((c) => ['fauna', 'effect'].includes(c.type))).toBe(false);
      expect(cosmetics.map((c) => c.id).join(' ')).not.toMatch(
        /blossom|fruit|firefl|glow|bird|petal/,
      );
    });
  });

  describe('species ownership', () => {
    it('owns the signature species without a row, selectable, and the current tree uses it', async () => {
      const ada = await t.signUp('ada@example.com');
      const body = await get<SpeciesBody>(ada, '/me/species');
      expect(body.items).toEqual([
        {
          id: 'signature',
          name: 'Signature Tree',
          description: expect.any(String) as string,
          rarity: 'common',
          baseSpeciesId: null,
          selectable: true,
        },
      ]);
      expect(body.current).toEqual({
        year: 2026,
        month: 10,
        speciesId: 'signature',
        locked: false,
      });
      expect(await ownedSpecies(ada.userId)).toEqual([]);
    });

    it('unlocks Oak with First Session, reported by the session that caused it', async () => {
      const ada = await t.signUp('ada@example.com');
      const { body } = await submit(ada, '2026-10-07T18:00:00.000Z', 25);
      expect(ids(body.progression?.newlyEarnedBadges)).toEqual(['first-session']);
      expect(body.progression?.newlyUnlockedSpecies).toEqual([
        {
          id: 'oak',
          name: 'Oak',
          description: expect.any(String) as string,
          rarity: 'common',
          baseSpeciesId: null,
          unlockedAt: NOW,
        },
      ]);
      expect(body.progression?.newlyUnlockedCosmetics).toEqual([]);
      expect(ids((await get<SpeciesBody>(ada, '/me/species')).items)).toEqual(['signature', 'oak']);
    });

    it('grants each reward once under concurrent evaluations, and keeps users apart', async () => {
      const ada = await t.signUp('ada@example.com');
      const bob = await t.signUp('bob@example.com');
      await seed(
        ada,
        dateRange('2026-09-01', 7).map((date) => ({ date, minutes: 100 })),
      );
      await Promise.all(Array.from({ length: 6 }, () => achievements.reconcile(ada.userId)));
      expect(await ownedSpecies(ada.userId)).toEqual(['oak', 'pine', 'sakura']);
      expect(await ownedSpecies(bob.userId)).toEqual([]);
      expect(ids((await get<SpeciesBody>(bob, '/me/species')).items)).toEqual(['signature']);
    });

    it('keeps an owned species when it is retired, no longer selectable', async () => {
      const ada = await septemberUser();
      await t.prisma.treeSpecies.update({ where: { id: 'oak' }, data: { status: 'retired' } });
      const body = await get<SpeciesBody>(ada, '/me/species');
      expect(body.items.find((s) => s.id === 'oak')).toMatchObject({ selectable: false });
      expect(await ownedSpecies(ada.userId)).toContain('oak');
      expect((await select(ada, 'oak').expect(422)).body).toMatchObject({
        code: 'species_not_selectable',
      });
    });

    it('unlocks the rare variants with their achievements, never Moon or Crystal trees', async () => {
      const ada = await t.signUp('ada@example.com');
      // 21 days of 1430 minutes: 500 hours. Then a 100-day run of short days.
      await seed(ada, [
        ...dateRange('2026-01-01', 21).map((date) => ({ date, minutes: 1_430 })),
        ...dateRange('2026-05-01', 100).map((date) => ({ date, minutes: 10 })),
      ]);
      await get(ada, '/me/species');
      const owned = await ownedSpecies(ada.userId);
      expect(owned).toEqual(
        expect.arrayContaining(['golden-sakura', 'ancient-pine', 'bonsai', 'fantasy']),
      );
      expect(owned).not.toContain('moon-tree');
      expect(owned).not.toContain('crystal-tree');
    });
  });

  describe('species selection and lock', () => {
    it('chooses an owned species for the current Seed, and changes it while still a Seed', async () => {
      const ada = await septemberUser();
      const oak = await select(ada, 'oak').expect(200);
      expect((oak.body as TreeBody).tree.species).toBe('oak');
      await select(ada, 'pine').expect(200);
      await select(ada, 'pine').expect(200);
      const current = await get<SpeciesBody>(ada, '/me/species');
      expect(current.current).toMatchObject({ speciesId: 'pine', locked: false });
      expect((await get<TreeBody>(ada, '/me/trees/current')).tree.species).toBe('pine');
    });

    it('refuses a species not owned or unknown, and a malformed body', async () => {
      const ada = await septemberUser();
      expect((await select(ada, 'maple').expect(422)).body).toMatchObject({
        code: 'species_not_owned',
      });
      expect((await select(ada, 'moon-tree').expect(422)).body).toMatchObject({
        code: 'species_not_owned',
      });
      await select(ada, 42).expect(400);
      await t.http().put('/me/trees/current/species').set(ada.auth).send({}).expect(400);
    });

    it('freezes the species with the first counted session; a discarded one does not', async () => {
      const ada = await septemberUser();
      await select(ada, 'oak').expect(200);
      const discarded = await submit(ada, '2026-10-07T10:00:00.000Z', 3);
      expect(discarded.body.counted).toBe(false);
      await select(ada, 'sakura').expect(200);
      const counted = await submit(ada, '2026-10-07T11:00:00.000Z', 30);
      expect(counted.body.growth?.tree?.species).toBe('sakura');
      expect((await select(ada, 'oak').expect(409)).body).toMatchObject({ code: 'species_locked' });
      expect((await get<SpeciesBody>(ada, '/me/species')).current).toMatchObject({
        speciesId: 'sakura',
        locked: true,
      });
    });

    it('never needs a choice: a first session grows the signature tree', async () => {
      const ada = await t.signUp('ada@example.com');
      const { status, body } = await submit(ada, '2026-10-07T18:00:00.000Z', 25);
      expect(status).toBe(201);
      expect(body.growth?.tree?.species).toBe('signature');
    });

    it('never changes an archived tree: not by selection, late sessions, or reconciliation', async () => {
      const ada = await t.signUp('ada@example.com', 'UTC', '2026-08-15T00:00:00.000Z');
      await t.setNow('2026-09-10T20:00:00.000Z');
      await submit(ada, '2026-09-10T08:00:00.000Z', 600);
      await t.setNow(NOW);
      await select(ada, 'oak').expect(200);
      await submit(ada, '2026-09-20T08:00:00.000Z', 30); // late September session
      await achievements.reconcile(ada.userId);
      const september = await t.prisma.monthlyTree.findUniqueOrThrow({
        where: { userId_year_month: { userId: ada.userId, year: 2026, month: 9 } },
      });
      expect(september).toMatchObject({ status: 'archived', species: 'signature' });
      expect((await get<TreeBody>(ada, '/me/trees/current')).tree.species).toBe('oak');
    });

    it('grows every species the same: a species is presentation only', async () => {
      const ada = await septemberUser('ada@example.com');
      const bob = await septemberUser('bob@example.com');
      await select(ada, 'pine').expect(200);
      const a = await submit(ada, '2026-10-07T10:00:00.000Z', 95);
      const b = await submit(bob, '2026-10-07T10:00:00.000Z', 95);
      expect(a.body.growth?.tree?.species).toBe('pine');
      expect(b.body.growth?.tree?.species).toBe('signature');
      expect(a.body.growth?.tree?.progress).toEqual(b.body.growth?.tree?.progress);
      const treeA = await t.prisma.monthlyTree.findFirstOrThrow({
        where: { userId: ada.userId, month: 10 },
      });
      const treeB = await t.prisma.monthlyTree.findFirstOrThrow({
        where: { userId: bob.userId, month: 10 },
      });
      for (const key of ['stage', 'fullnessLevel', 'blossomLevel', 'richnessTier'] as const) {
        expect(treeA[key]).toEqual(treeB[key]);
      }
    });

    it('ends with one species frozen whatever wins the race with the first session', async () => {
      for (const email of ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']) {
        const user = await septemberUser(email);
        await get(user, '/me/trees/current');
        const [selection, session] = await Promise.all([
          select(user, 'oak'),
          submit(user, '2026-10-07T10:00:00.000Z', 30),
        ]);
        const stored = await t.prisma.monthlyTree.findFirstOrThrow({
          where: { userId: user.userId, month: 10 },
        });
        expect(session.body.growth?.tree?.species).toBe(stored.species);
        if (selection.status === 200) expect(stored.species).toBe('oak');
        else {
          expect(selection.status).toBe(409);
          expect(stored.species).toBe('signature');
        }
      }
    });

    it('keeps the last of concurrent selections on a Seed, whole', async () => {
      const ada = await septemberUser();
      const results = await Promise.all([select(ada, 'oak'), select(ada, 'pine')]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const stored = await t.prisma.monthlyTree.findFirstOrThrow({
        where: { userId: ada.userId, month: 10 },
      });
      expect(['oak', 'pine']).toContain(stored.species);
      expect(await t.prisma.monthlyTree.count({ where: { userId: ada.userId, month: 10 } })).toBe(
        1,
      );
    });

    it('lets a chosen Seed rest when the month has no counted focus', async () => {
      const ada = await septemberUser();
      await select(ada, 'oak').expect(200);
      await t.setNow('2026-11-02T10:00:00.000Z');
      expect(await get<{ kind: string }>(ada, '/me/trees/2026/10')).toEqual({
        kind: 'resting',
        year: 2026,
        month: 10,
      });
    });
  });

  describe('cosmetics and equipment', () => {
    it('owns the default cosmetics without rows, and earns linked ones', async () => {
      const ada = await t.signUp('ada@example.com');
      const body = await get<CosmeticsBody>(ada, '/me/cosmetics');
      expect(body.items).toEqual([
        expect.objectContaining({ id: 'meadow', type: 'background', equipped: false }),
        expect.objectContaining({ id: 'mossy-stones', type: 'decoration', equipped: false }),
      ]);
      expect(await ownedCosmetics(ada.userId)).toEqual([]);

      await seed(ada, [...dateRange('2026-09-01', 3).map((date) => ({ date, minutes: 1_000 }))]);
      const after = await get<CosmeticsBody>(ada, '/me/cosmetics');
      expect(ids(after.items)).toEqual(['meadow', 'mossy-stones', 'stone-lantern']);
      expect(await ownedCosmetics(ada.userId)).toEqual(['stone-lantern']);
    });

    it('equips owned cosmetics by slot, replaces, clears, and is idempotent', async () => {
      const ada = await t.signUp('ada@example.com');
      await seed(
        ada,
        dateRange('2026-09-01', 3).map((date) => ({ date, minutes: 1_000 })),
      );
      await get(ada, '/me/cosmetics');
      const empty = await get<EquipmentBody>(ada, '/me/equipment');
      expect(empty).toEqual({
        forest: { background: null, decoration: null, fauna: null, weather: null, effect: null },
        profileFrame: null,
      });
      await equip(ada, 'decoration', 'mossy-stones').expect(200);
      const replaced = await equip(ada, 'decoration', 'stone-lantern').expect(200);
      expect((replaced.body as EquipmentBody).forest['decoration']).toMatchObject({
        id: 'stone-lantern',
        type: 'decoration',
        artworkId: expect.any(String) as string,
      });
      const again = await equip(ada, 'decoration', 'stone-lantern').expect(200);
      expect(again.body).toEqual(replaced.body);
      await equip(ada, 'background', 'meadow').expect(200);
      expect(
        (await get<CosmeticsBody>(ada, '/me/cosmetics')).items
          .filter((c) => c.equipped)
          .map((c) => c.id),
      ).toEqual(['meadow', 'stone-lantern']);
      const cleared = await unequip(ada, 'decoration').expect(200);
      expect((cleared.body as EquipmentBody).forest['decoration']).toBeNull();
      await unequip(ada, 'decoration').expect(200);
      expect(await t.prisma.userEquipment.count({ where: { userId: ada.userId } })).toBe(1);
    });

    it('refuses unowned cosmetics, the wrong slot, and unknown slots, changing nothing', async () => {
      const ada = await t.signUp('ada@example.com');
      await equip(ada, 'decoration', 'mossy-stones').expect(200);
      expect((await equip(ada, 'decoration', 'stone-lantern').expect(422)).body).toMatchObject({
        code: 'cosmetic_not_owned',
      });
      expect((await equip(ada, 'decoration', 'no-such-thing').expect(422)).body).toMatchObject({
        code: 'cosmetic_not_owned',
      });
      expect((await equip(ada, 'background', 'mossy-stones').expect(422)).body).toMatchObject({
        code: 'cosmetic_wrong_slot',
      });
      await equip(ada, 'hat', 'mossy-stones').expect(400);
      await equip(ada, 'decoration', 7).expect(400);
      expect((await get<EquipmentBody>(ada, '/me/equipment')).forest['decoration']).toMatchObject({
        id: 'mossy-stones',
      });
      // The database refuses them too.
      await expect(
        t.prisma.userEquipment.create({
          data: { userId: ada.userId, slot: 'background', cosmeticId: 'misty-hills' },
        }),
      ).rejects.toThrow();
      await expect(
        t.prisma.userEquipment.create({
          data: { userId: ada.userId, slot: 'background', cosmeticId: 'mossy-stones' },
        }),
      ).rejects.toThrow();
    });

    it('keeps users apart', async () => {
      const ada = await t.signUp('ada@example.com');
      const bob = await t.signUp('bob@example.com');
      await seed(
        ada,
        dateRange('2026-09-01', 3).map((date) => ({ date, minutes: 1_000 })),
      );
      await get(ada, '/me/cosmetics');
      await equip(ada, 'decoration', 'stone-lantern').expect(200);
      await equip(bob, 'decoration', 'stone-lantern').expect(422);
      expect((await get<EquipmentBody>(bob, '/me/equipment')).forest['decoration']).toBeNull();
      expect(ids((await get<CosmeticsBody>(bob, '/me/cosmetics')).items)).toEqual([
        'meadow',
        'mossy-stones',
      ]);
    });

    it('keeps an equipped cosmetic owned and equipped when it is retired', async () => {
      const ada = await t.signUp('ada@example.com');
      await seed(
        ada,
        dateRange('2026-09-01', 3).map((date) => ({ date, minutes: 1_000 })),
      );
      await get(ada, '/me/cosmetics');
      await equip(ada, 'decoration', 'stone-lantern').expect(200);
      await t.prisma.cosmeticDefinition.update({
        where: { id: 'stone-lantern' },
        data: { status: 'retired' },
      });
      expect((await get<EquipmentBody>(ada, '/me/equipment')).forest['decoration']).toMatchObject({
        id: 'stone-lantern',
      });
      expect(await ownedCosmetics(ada.userId)).toEqual(['stone-lantern']);
    });

    it('puts the profile frame on the profile only, never on trees, the forest, or recaps', async () => {
      const ada = await t.signUp('ada@example.com', 'UTC', '2026-08-15T00:00:00.000Z');
      await seed(
        ada,
        dateRange('2026-09-01', 30).map((date) => ({ date, minutes: 20 })),
      );
      await get(ada, '/me/cosmetics');
      const res = await equip(ada, 'profile_frame', 'twig-frame').expect(200);
      expect((res.body as EquipmentBody).profileFrame).toMatchObject({ id: 'twig-frame' });
      expect(Object.values((res.body as EquipmentBody).forest).every((v) => v === null)).toBe(true);
      await equip(ada, 'decoration', 'twig-frame').expect(422);
      const surfaces = [
        await get(ada, '/me/trees/current'),
        await get(ada, '/me/forest'),
        await get(ada, '/me/trees/2026/9'),
        await get(ada, '/me/trees/2026/9/recap'),
        await get(ada, '/me/home'),
      ];
      for (const surface of surfaces) expect(JSON.stringify(surface)).not.toContain('twig-frame');
    });

    it('changes no tree, archive, recap, or forest progression when equipping', async () => {
      const ada = await t.signUp('ada@example.com', 'UTC', '2026-08-15T00:00:00.000Z');
      await seed(
        ada,
        dateRange('2026-09-01', 30).map((date) => ({ date, minutes: 200 })),
      );
      const forest = await get<{ progression: unknown }>(ada, '/me/forest');
      await get(ada, '/me/trees/current');
      const before = await digest([...CORE, 'forest_area_unlocks']);
      await equip(ada, 'background', 'misty-hills').expect(200);
      await equip(ada, 'decoration', 'stone-lantern').expect(200);
      await equip(ada, 'profile_frame', 'twig-frame').expect(200);
      await unequip(ada, 'background').expect(200);
      expect(await digest([...CORE, 'forest_area_unlocks'])).toEqual(before);
      expect((await get<{ progression: unknown }>(ada, '/me/forest')).progression).toEqual(
        forest.progression,
      );
    });
  });

  describe('replay and reconciliation', () => {
    it('reports a session’s rewards once: replay answers the same, a later session nothing', async () => {
      const ada = await t.signUp('ada@example.com');
      const id = randomUUID();
      const first = await submit(ada, '2026-10-07T18:00:00.000Z', 25, id);
      expect(ids(first.body.progression?.newlyUnlockedSpecies)).toEqual(['oak']);
      const replay = await submit(ada, '2026-10-07T18:00:00.000Z', 25, id);
      expect(replay.status).toBe(200);
      expect(replay.body.progression).toEqual(first.body.progression);
      expect(await ownedSpecies(ada.userId)).toEqual(['oak']);
      const later = await submit(ada, '2026-10-07T07:00:00.000Z', 610);
      expect(ids(later.body.progression?.newlyEarnedBadges)).toEqual(['focus-hours:10']);
      expect(ids(later.body.progression?.newlyUnlockedSpecies)).toEqual(['sakura']);
      expect((await submit(ada, '2026-10-07T18:00:00.000Z', 25, id)).body.progression).toEqual(
        first.body.progression,
      );
    });

    it('reports a recovery’s rewards once, the same on a repeat', async () => {
      const ada = await t.signUp('ada@example.com');
      const missed = '2026-10-05';
      await t.focus(ada, [
        ...dateRange(addDays(missed, -29), 29).map((date) => [date, 15] as [string, number]),
        ['2026-10-06', 15],
      ]);
      await get(ada, '/me/badges');
      const res = await t
        .http()
        .post('/me/streak/recoveries')
        .set(ada.auth)
        .send({ missedDate: missed });
      expect(res.status).toBe(201);
      const progression = (res.body as { progression: Progression }).progression;
      expect(ids(progression.newlyEarnedBadges)).toEqual(['focus-streak:30']);
      expect(ids(progression.newlyUnlockedSpecies)).toEqual(['bonsai']);
      expect(ids(progression.newlyUnlockedCosmetics)).toEqual(['twig-frame']);
      const repeat = await t
        .http()
        .post('/me/streak/recoveries')
        .set(ada.auth)
        .send({ missedDate: missed })
        .expect(200);
      expect((repeat.body as { progression: Progression }).progression).toEqual(progression);
      expect(await ownedCosmetics(ada.userId)).toEqual(['twig-frame']);
    });

    it('grants a pre-A4.3 badge owner the linked rewards, without an unlock event or Core change', async () => {
      const ada = await t.signUp('ada@example.com');
      await seed(
        ada,
        dateRange('2026-09-01', 7).map((date) => ({ date, minutes: 100 })),
      );
      // Badges granted before A4.3 existed: ownership rows without their rewards.
      await t.prisma.userBadge.createMany({
        data: ['first-session', 'focus-hours:10', 'focus-streak:3', 'focus-streak:7'].map(
          (badgeId) => ({
            userId: ada.userId,
            badgeId,
            earnedAt: new Date('2026-09-07T10:00:00.000Z'),
          }),
        ),
      });
      const core = await digest(CORE);
      // Reconciliation alone (reading /me/species also resolves the current tree, like Home).
      const evaluation = await achievements.reconcile(ada.userId);
      expect(evaluation.species.map((g) => [g.id, g.causedByAction])).toEqual([
        ['oak', false],
        ['sakura', false],
        ['pine', false],
      ]);
      const rows = await t.prisma.userSpecies.findMany({ where: { userId: ada.userId } });
      for (const row of rows) expect(row.unlockedAt).toEqual(new Date(NOW));
      expect(await digest(CORE)).toEqual(core);
      expect(ids((await get<SpeciesBody>(ada, '/me/species')).items)).toEqual([
        'signature',
        'oak',
        'sakura',
        'pine',
      ]);
      // The next session reports no reward it did not cause.
      const { body } = await submit(ada, '2026-10-07T10:00:00.000Z', 20);
      expect(body.progression).toEqual({
        newlyEarnedBadges: [],
        newlyUnlockedSpecies: [],
        newlyUnlockedCosmetics: [],
      });
    });
  });
});
