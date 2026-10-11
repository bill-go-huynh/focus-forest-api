import { randomUUID } from 'node:crypto';

import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A5.9 Seasonal content (spec §17, docs/03 §10, docs/06 SeasonalTheme / LimitedCollection,
 * docs/12 Phase 17): hemisphere-aware themes that change the environment and never the earned
 * tree, and limited collections earned with normal focus and owned forever.
 */

const t = new ConsistencyHarness('2026-10-14T10:00:00.000Z');
type Auth = Record<string, string>;
interface User {
  userId: string;
  auth: Auth;
  topicId: string;
}
type Body = Record<string, unknown>;
interface Reward {
  id: string;
  kind: string;
  item: Body;
  requiredActiveDays: number;
  activeDays: number;
  owned: boolean;
}
interface Season {
  hemisphere: string;
  hemisphereSource: string;
  theme: {
    id: string;
    name: string;
    environmentId: string;
    startsAt: string;
    endsAt: string;
  } | null;
  rewards: Reward[];
}

const WINDOW = {
  availability: 'limited' as const,
  availableFrom: new Date('2026-09-22T00:00:00Z'),
  availableUntil: new Date('2026-12-21T00:00:00Z'),
  status: 'active' as const,
};

/** Autumn in the north and spring in the south, 22 September to 21 December. */
async function themes() {
  await t.prisma.cosmeticDefinition.createMany({
    data: [
      {
        id: 'falling-leaves',
        type: 'decoration',
        rarity: 'common',
        source: 'season',
        name: 'Falling Leaves',
        description: 'Leaves drifting through the autumn forest.',
        artworkId: 'falling-leaves',
        ...WINDOW,
      },
      {
        id: 'sakura-petals',
        type: 'decoration',
        rarity: 'common',
        source: 'season',
        name: 'Sakura Petals',
        description: 'Petals of a southern spring.',
        artworkId: 'sakura-petals',
        ...WINDOW,
      },
    ],
  });
  await t.prisma.badgeDefinition.create({
    data: {
      id: 'autumn-steady',
      category: 'event',
      rarity: 'rare',
      source: 'season',
      name: 'Autumn Steady',
      description: 'Focused on three autumn days.',
      artworkId: 'autumn-steady',
      ...WINDOW,
    },
  });
  await t.prisma.seasonalTheme.create({
    data: {
      id: 'autumn-north',
      name: 'Autumn',
      description: 'Warm leaves and long light.',
      environmentId: 'autumn',
      hemisphere: 'north',
      status: 'active',
      startsAt: new Date('2026-09-22T00:00:00Z'),
      endsAt: new Date('2026-12-21T00:00:00Z'),
      rewards: {
        create: [
          { id: 'leaves', cosmeticId: 'falling-leaves', requiredActiveDays: 1, sortOrder: 1 },
          { id: 'steady', badgeId: 'autumn-steady', requiredActiveDays: 3, sortOrder: 2 },
        ],
      },
    },
  });
  await t.prisma.seasonalTheme.create({
    data: {
      id: 'spring-south',
      name: 'Sakura',
      description: 'A southern spring in bloom.',
      environmentId: 'sakura',
      hemisphere: 'south',
      status: 'active',
      startsAt: new Date('2026-09-22T00:00:00Z'),
      endsAt: new Date('2026-12-21T00:00:00Z'),
      rewards: { create: [{ id: 'petals', cosmeticId: 'sakura-petals', requiredActiveDays: 1 }] },
    },
  });
}

const person = (name: string, timezone = 'UTC'): Promise<User> =>
  t.signUp(`${name}@example.com`, timezone, '2026-09-01T00:00:00.000Z');
const season = async (user: User) =>
  (await t.http().get('/me/season').set(user.auth).expect(200)).body as Season;
const setHemisphere = (user: User, hemisphere: string | null) =>
  t.http().put('/me/season/hemisphere').set(user.auth).send({ hemisphere });

describe('Seasonal content (A5.9, HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-14T10:00:00.000Z');
    await t.activateConfig();
  });

  describe('themes', () => {
    it("follow the user's hemisphere, from the time zone or their choice", async () => {
      await themes();
      const ada = await person('ada');
      const bea = await person('bea', 'Australia/Sydney');
      expect(await season(ada)).toMatchObject({
        hemisphere: 'north',
        hemisphereSource: 'time_zone',
        theme: { id: 'autumn-north', name: 'Autumn', environmentId: 'autumn' },
      });
      expect(await season(bea)).toMatchObject({
        hemisphere: 'south',
        hemisphereSource: 'time_zone',
        theme: { id: 'spring-south', environmentId: 'sakura' },
      });

      const set = await setHemisphere(bea, 'north').expect(200);
      expect(set.body).toMatchObject({
        hemisphere: 'north',
        hemisphereSource: 'set',
        theme: { id: 'autumn-north' },
      });
      await setHemisphere(bea, null).expect(200);
      expect((await season(bea)).hemisphereSource).toBe('time_zone');
      await setHemisphere(bea, 'east').expect(400);
    });

    it('defaults to the north without a time zone, and is null outside every theme', async () => {
      await themes();
      const ada = await t.signUp('ada@example.com', null, '2026-09-01T00:00:00.000Z');
      expect(await season(ada)).toMatchObject({
        hemisphere: 'north',
        hemisphereSource: 'default',
      });
      await t.setNow('2026-12-21T00:00:00.000Z');
      expect(await season(ada)).toEqual({
        hemisphere: 'north',
        hemisphereSource: 'default',
        theme: null,
        rewards: [],
      });
    });

    it('never show planned themes, and prefer the first by sort order', async () => {
      await themes();
      await t.prisma.seasonalTheme.create({
        data: {
          id: 'night-forest',
          name: 'Night Forest',
          description: 'Fireflies for everyone.',
          environmentId: 'night',
          hemisphere: null,
          status: 'active',
          sortOrder: -1,
          startsAt: new Date('2026-10-01T00:00:00Z'),
          endsAt: new Date('2026-11-01T00:00:00Z'),
        },
      });
      await t.prisma.seasonalTheme.create({
        data: {
          id: 'rainy-season',
          name: 'Rainy Season',
          description: 'Soft rain.',
          environmentId: 'rain',
          status: 'planned',
          sortOrder: -2,
          startsAt: new Date('2026-10-01T00:00:00Z'),
          endsAt: new Date('2026-11-01T00:00:00Z'),
        },
      });
      const ada = await person('ada');
      const bea = await person('bea', 'Pacific/Auckland');
      expect((await season(ada)).theme?.id).toBe('night-forest');
      expect((await season(bea)).theme?.id).toBe('night-forest');
    });

    it("never change the earned tree's answer", async () => {
      const ada = await person('ada');
      await t.focus(ada, [['2026-10-13', 60]]);
      const before: unknown = (await t.http().get('/me/trees/current').set(ada.auth).expect(200))
        .body;
      await themes();
      await season(ada);
      const after: unknown = (await t.http().get('/me/trees/current').set(ada.auth).expect(200))
        .body;
      expect(after).toEqual(before);
    });
  });

  describe('limited collections', () => {
    it('are earned with normal focus in the window, reported after the session', async () => {
      await themes();
      const ada = await person('ada');
      await t.focus(ada, [
        ['2026-09-21', 60],
        ['2026-10-10', 30, 'discarded'],
      ]);
      const before = await season(ada);
      expect(before.rewards.map((r) => [r.id, r.kind, r.activeDays, r.owned])).toEqual([
        ['leaves', 'cosmetic', 0, false],
        ['steady', 'badge', 0, false],
      ]);
      expect(before.rewards[0]!.item).toMatchObject({ id: 'falling-leaves' });

      await t.setNow('2026-10-14T14:00:00.000Z');
      const id = randomUUID();
      const res = await t.submit(ada, '2026-10-14T08:00:00.000Z', 30, id).expect(201);
      const progression = (res.body as { progression: Body }).progression;
      expect((progression['newlyUnlockedCosmetics'] as { id: string }[]).map((c) => c.id)).toEqual([
        'falling-leaves',
      ]);
      // The replay answers the same.
      const replay = await t.submit(ada, '2026-10-14T08:00:00.000Z', 30, id).expect(200);
      expect((replay.body as { progression: Body }).progression).toEqual(progression);

      await t.focus(ada, [
        ['2026-10-12', 20],
        ['2026-10-13', 20],
      ]);
      const after = await season(ada);
      expect(after.rewards.map((r) => [r.id, r.activeDays, r.owned])).toEqual([
        ['leaves', 3, true],
        ['steady', 3, true],
      ]);
    });

    it('are never earned once the theme has ended, even with focus from its window', async () => {
      await themes();
      // The content itself stays acquirable longer than the theme.
      await t.prisma.cosmeticDefinition.update({
        where: { id: 'falling-leaves' },
        data: { availableUntil: new Date('2027-03-01T00:00:00Z') },
      });
      const ada = await person('ada');
      await t.focus(ada, [['2026-12-20', 30]]);
      await t.setNow('2026-12-22T14:00:00.000Z');
      const res = await t.submit(ada, '2026-12-22T08:00:00.000Z', 30).expect(201);
      const progression = (res.body as { progression: Body }).progression;
      expect(progression['newlyUnlockedCosmetics']).toEqual([]);
      expect(await t.prisma.userCosmetic.count({ where: { userId: ada.userId } })).toBe(0);
    });

    it('are earned only in the hemisphere the theme is for', async () => {
      await themes();
      const bea = await person('bea', 'Australia/Sydney');
      await t.setNow('2026-10-14T14:00:00.000Z');
      await t.submit(bea, '2026-10-14T00:00:00.000Z', 30).expect(201);
      const owned = await t.prisma.userCosmetic.findMany({
        where: { userId: bea.userId },
        select: { cosmeticId: true },
      });
      expect(owned).toEqual([{ cosmeticId: 'sakura-petals' }]);
    });

    it('stay owned after the season, and are hidden from the collection until owned', async () => {
      await themes();
      const ada = await person('ada');
      const bob = await person('bob');
      await t.focus(ada, [['2026-10-13', 30]]);
      await season(ada);
      await t.setNow('2027-01-10T12:00:00.000Z');
      await t.prisma.seasonalTheme.update({
        where: { id: 'autumn-north' },
        data: { status: 'retired' },
      });
      expect((await season(ada)).theme).toBeNull();
      const decorations = async (user: User) => {
        const body = (await t.http().get('/me/collection').set(user.auth).expect(200)).body as {
          sections: { items: { id: string; owned: boolean }[] }[];
        };
        return body.sections
          .flatMap((section) => section.items)
          .filter((item) => ['falling-leaves', 'sakura-petals', 'autumn-steady'].includes(item.id));
      };
      expect(await decorations(ada)).toEqual([
        expect.objectContaining({ id: 'falling-leaves', owned: true }),
      ]);
      expect(await decorations(bob)).toEqual([]);
    });
  });

  describe('schema', () => {
    it('needs exactly one reward item, at least one day, and a window', async () => {
      await themes();
      const reward = (over: Body) =>
        t.prisma.seasonalReward.create({
          data: {
            themeId: 'autumn-north',
            id: 'extra',
            requiredActiveDays: 1,
            cosmeticId: 'falling-leaves',
            ...over,
          },
        });
      await expect(reward({ badgeId: 'autumn-steady' })).rejects.toThrow();
      await expect(reward({ cosmeticId: null })).rejects.toThrow();
      await expect(reward({ requiredActiveDays: 0 })).rejects.toThrow();
      await expect(
        t.prisma.seasonalTheme.create({
          data: {
            id: 'backwards',
            name: 'Backwards',
            description: 'Ends before it starts.',
            environmentId: 'winter',
            status: 'active',
            startsAt: new Date('2026-12-01T00:00:00Z'),
            endsAt: new Date('2026-11-01T00:00:00Z'),
          },
        }),
      ).rejects.toThrow();
      await reward({});
    });
  });
});
