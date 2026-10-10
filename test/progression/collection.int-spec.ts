import { randomUUID } from 'node:crypto';

import type { LocalDate } from '../../src/common/local-date.js';
import { ConsistencyHarness, dateRange } from '../support/consistency-harness.js';

/**
 * A4.4 Collection Book (HTTP + PostgreSQL): a derived, calm record of what the user owns and can
 * still obtain. Owned items stay forever; locked ones appear only when they can really be
 * obtained now, with a structured hint; planned, retired-unowned, and unreachable content is
 * hidden. Reading it reconciles ownership once and never creates Core state.
 */

const MIN = 60_000;
const NOW = '2026-10-07T20:00:00.000Z';
const t = new ConsistencyHarness(NOW);

type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

interface Hint {
  type: string;
  achievementId?: string;
  name?: string;
  description?: string;
  unit?: string;
  target?: number;
  current?: number | null;
}
interface Item {
  id: string;
  kind: 'species' | 'badge' | 'cosmetic';
  name: string;
  description: string;
  rarity: string;
  artworkId: string | null;
  owned: boolean;
  ownedAt: string | null;
  source: string;
  availability: {
    status: string;
    limited: boolean;
    availableFrom: string | null;
    availableUntil: string | null;
    obtainableNow: boolean;
  };
  unlock: Hint | null;
  baseSpeciesId?: string | null;
  selected?: boolean;
  category?: string;
  showcasePosition?: number | null;
  type?: string;
  equipped?: boolean;
}
interface Section {
  kind: 'species' | 'badges' | 'cosmetics';
  owned: number;
  total: number;
  items: Item[];
}
interface CollectionBody {
  sections: Section[];
}

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

const collection = async (user: User) =>
  (await t.http().get('/me/collection').set(user.auth).expect(200)).body as CollectionBody;
const section = (body: CollectionBody, kind: Section['kind']) => {
  const found = body.sections.find((s) => s.kind === kind);
  if (!found) throw new Error(`no ${kind} section`);
  return found;
};
const item = (body: CollectionBody, kind: Section['kind'], id: string) =>
  section(body, kind).items.find((i) => i.id === id);
const idsOf = (body: CollectionBody, kind: Section['kind']) =>
  section(body, kind).items.map((i) => i.id);

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

describe('A4.4 Collection Book (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow(NOW);
    await t.activateConfig();
  });

  it('groups species, badges, and cosmetics in a fixed order, each counted, with no percentage', async () => {
    const ada = await t.signUp('ada@example.com');
    const body = await collection(ada);
    expect(Object.keys(body)).toEqual(['sections']);
    expect(body.sections.map((s) => [s.kind, s.owned, s.total])).toEqual([
      ['species', 1, 9],
      // 9 Focus and Consistency badges, and the 2 Focus Together badges (A5.4).
      ['badges', 0, 11],
      ['cosmetics', 2, 5],
    ]);
    expect(JSON.stringify(body)).not.toMatch(/percent|completion|progressRatio/i);
  });

  it('reads without creating or changing any Core state (no tree, no month context)', async () => {
    const ada = await t.signUp('ada@example.com');
    const before = await digest(CORE);
    await collection(ada);
    expect(await digest(CORE)).toEqual(before);
    expect(await t.prisma.monthlyTree.count()).toBe(0);
    expect(await t.prisma.monthAttributionContext.count()).toBe(0);
  });

  describe('species', () => {
    it('owns the signature tree by rule, selected for the month; the rest locked with hints', async () => {
      const ada = await t.signUp('ada@example.com');
      const body = await collection(ada);
      expect(idsOf(body, 'species')).toEqual([
        'signature',
        'oak',
        'sakura',
        'pine',
        'maple',
        'bonsai',
        'fantasy',
        'golden-sakura',
        'ancient-pine',
      ]);
      expect(item(body, 'species', 'signature')).toEqual({
        id: 'signature',
        kind: 'species',
        name: 'Signature Tree',
        description: expect.any(String) as string,
        rarity: 'common',
        artworkId: null,
        owned: true,
        ownedAt: null,
        source: 'system',
        availability: {
          status: 'active',
          limited: false,
          availableFrom: null,
          availableUntil: null,
          obtainableNow: true,
        },
        unlock: null,
        baseSpeciesId: null,
        selected: true,
      });
      expect(item(body, 'species', 'oak')).toMatchObject({
        owned: false,
        ownedAt: null,
        selected: false,
        unlock: {
          type: 'achievement',
          achievementId: 'first-session',
          name: 'First Session',
          unit: 'sessions',
          target: 1,
          current: null, // First Session hides its progress
        },
      });
      expect(item(body, 'species', 'golden-sakura')).toMatchObject({
        rarity: 'legendary',
        baseSpeciesId: 'sakura',
        unlock: { name: '500 Hours', unit: 'minutes', target: 30_000, current: 0 },
      });
      expect(idsOf(body, 'species')).not.toContain('moon-tree');
      expect(idsOf(body, 'species')).not.toContain('crystal-tree');
    });

    it('owns Oak after First Session, with its unlock time and no hint', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.submit(ada, '2026-10-07T18:00:00.000Z', 25).expect(201);
      const body = await collection(ada);
      expect(item(body, 'species', 'oak')).toMatchObject({
        owned: true,
        ownedAt: NOW,
        unlock: null,
      });
      expect(section(body, 'species')).toMatchObject({ owned: 2, total: 9 });
    });

    it('marks only the current growing month’s species selected, never an archived one', async () => {
      const ada = await t.signUp('ada@example.com', 'UTC', '2026-08-15T00:00:00.000Z');
      await seed(
        ada,
        dateRange('2026-09-01', 7).map((date) => ({ date, minutes: 100 })),
      );
      await t.http().get('/me/trees/current').set(ada.auth).expect(200); // archives September
      await collection(ada); // reconciles: Pine (7-day streak) is owned before it is chosen
      await t
        .http()
        .put('/me/trees/current/species')
        .set(ada.auth)
        .send({ speciesId: 'pine' })
        .expect(200);
      const body = await collection(ada);
      const selected = section(body, 'species')
        .items.filter((i) => i.selected)
        .map((i) => i.id);
      expect(selected).toEqual(['pine']);
      const september = await t.prisma.monthlyTree.findFirstOrThrow({
        where: { userId: ada.userId, month: 9 },
      });
      expect(september.species).toBe('signature');
    });
  });

  describe('badges', () => {
    it('shows earnable badges with progress, owned ones with time and showcase position', async () => {
      const ada = await t.signUp('ada@example.com');
      await seed(
        ada,
        dateRange('2026-09-01', 7).map((date) => ({ date, minutes: 100 })),
      );
      await t
        .http()
        .put('/me/badges/showcase')
        .set(ada.auth)
        .send({ badgeIds: ['focus-streak:7', 'first-session'] })
        .expect(200);
      const body = await collection(ada);
      expect(idsOf(body, 'badges')).toEqual([
        'first-session',
        'focus-hours:10',
        'focus-hours:50',
        'focus-hours:100',
        'focus-hours:500',
        'focus-streak:3',
        'focus-streak:7',
        'focus-streak:30',
        'focus-streak:100',
        'focus-together:first',
        'focus-buddy',
      ]);
      expect(item(body, 'badges', 'focus-streak:7')).toMatchObject({
        owned: true,
        ownedAt: NOW,
        category: 'consistency',
        showcasePosition: 1,
        unlock: null,
        artworkId: 'focus-streak-7',
      });
      expect(item(body, 'badges', 'first-session')).toMatchObject({ showcasePosition: 2 });
      expect(item(body, 'badges', 'focus-streak:3')).toMatchObject({ showcasePosition: null });
      expect(item(body, 'badges', 'focus-hours:50')).toMatchObject({
        owned: false,
        unlock: {
          type: 'achievement',
          achievementId: 'focus-hours:50',
          name: '50 Hours',
          unit: 'minutes',
          target: 3000,
          current: 700,
        },
      });
      // Each hint reads its own measure: days for a streak, not minutes.
      expect(item(body, 'badges', 'focus-streak:30')?.unlock).toMatchObject({
        unit: 'days',
        target: 30,
        current: 7,
      });
      expect(JSON.stringify(body)).not.toMatch(
        /focused_minutes|counted_sessions|longest_streak_days/,
      );
    });

    it('hides planned badges and retired ones never owned; keeps retired ones owned', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.submit(ada, '2026-10-07T18:00:00.000Z', 25).expect(201);
      await t.prisma.badgeDefinition.updateMany({
        where: { id: { in: ['first-session', 'focus-hours:500'] } },
        data: { status: 'retired' },
      });
      const body = await collection(ada);
      const ids = idsOf(body, 'badges');
      for (const hidden of ['community-contributor', 'focus-hours:500']) {
        expect(ids).not.toContain(hidden);
      }
      expect(item(body, 'badges', 'first-session')).toMatchObject({
        owned: true,
        availability: { status: 'retired', obtainableNow: false },
      });
    });

    it('keeps badge category and rarity apart', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.prisma.badgeDefinition.create({
        data: {
          id: 'special-moment',
          category: 'rare',
          rarity: 'common',
          source: 'achievement',
          availability: 'permanent',
          status: 'active',
          name: 'Special Moment',
          description: 'For tests.',
          artworkId: 'special-moment',
          sortOrder: 200,
        },
      });
      await t.prisma.userBadge.create({
        data: { userId: ada.userId, badgeId: 'special-moment', earnedAt: new Date(NOW) },
      });
      const body = await collection(ada);
      expect(item(body, 'badges', 'special-moment')).toMatchObject({
        category: 'rare',
        rarity: 'common',
      });
      expect(item(body, 'badges', 'focus-hours:100')).toMatchObject({
        category: 'focus',
        rarity: 'rare',
      });
    });
  });

  describe('cosmetics', () => {
    it('owns the defaults, shows locked rewards with honest hints, and equipped state', async () => {
      const ada = await t.signUp('ada@example.com');
      await t
        .http()
        .put('/me/equipment/decoration')
        .set(ada.auth)
        .send({ cosmeticId: 'mossy-stones' })
        .expect(200);
      const body = await collection(ada);
      expect(idsOf(body, 'cosmetics')).toEqual([
        'meadow',
        'mossy-stones',
        'stone-lantern',
        'misty-hills',
        'twig-frame',
      ]);
      expect(item(body, 'cosmetics', 'meadow')).toMatchObject({
        owned: true,
        source: 'system',
        type: 'background',
        artworkId: 'meadow',
        equipped: false,
        unlock: null,
      });
      expect(item(body, 'cosmetics', 'mossy-stones')).toMatchObject({ equipped: true });
      expect(item(body, 'cosmetics', 'stone-lantern')).toMatchObject({
        name: 'Stone Lantern',
        owned: false,
        equipped: false,
        unlock: {
          type: 'achievement',
          name: '50 Hours',
          unit: 'minutes',
          target: 3000,
          current: 0,
        },
      });
      expect(item(body, 'cosmetics', 'twig-frame')).toMatchObject({
        name: 'Twig Frame',
        type: 'profile_frame',
        unlock: { name: '30-Day Streak', unit: 'days', target: 30, current: 0 },
      });
      expect(item(body, 'cosmetics', 'misty-hills')).toMatchObject({ name: 'Misty Hills' });
    });

    it('shows owned rewards, the equipped profile frame, and keeps a retired owned item', async () => {
      const ada = await t.signUp('ada@example.com');
      await seed(
        ada,
        dateRange('2026-09-01', 30).map((date) => ({ date, minutes: 200 })),
      );
      await t.http().get('/me/cosmetics').set(ada.auth).expect(200);
      await t
        .http()
        .put('/me/equipment/profile_frame')
        .set(ada.auth)
        .send({ cosmeticId: 'twig-frame' })
        .expect(200);
      await t.prisma.cosmeticDefinition.update({
        where: { id: 'stone-lantern' },
        data: { status: 'retired' },
      });
      const body = await collection(ada);
      expect(item(body, 'cosmetics', 'twig-frame')).toMatchObject({
        owned: true,
        ownedAt: NOW,
        equipped: true,
      });
      expect(item(body, 'cosmetics', 'stone-lantern')).toMatchObject({
        owned: true,
        availability: { status: 'retired', obtainableNow: false },
      });
      expect(section(body, 'cosmetics')).toMatchObject({ owned: 5, total: 5 });
      // Never owned and retired: no longer obtainable, so not shown (its achievement still is).
      const bob = await t.signUp('bob@example.com');
      const other = await collection(bob);
      expect(idsOf(other, 'cosmetics')).not.toContain('stone-lantern');
      expect(section(other, 'cosmetics')).toMatchObject({ owned: 2, total: 4 });
    });
  });

  it('is stable: the same answer twice, ordered by catalog whatever is owned', async () => {
    const ada = await t.signUp('ada@example.com');
    const before = await collection(ada);
    await t.submit(ada, '2026-10-07T18:00:00.000Z', 25).expect(201);
    const after = await collection(ada);
    expect(await collection(ada)).toEqual(after);
    for (const kind of ['species', 'badges', 'cosmetics'] as const) {
      expect(idsOf(after, kind)).toEqual(idsOf(before, kind));
    }
  });

  it('keeps users apart: ownership, progress, showcase, equipment', async () => {
    const ada = await t.signUp('ada@example.com');
    const bob = await t.signUp('bob@example.com');
    await seed(
      ada,
      dateRange('2026-09-01', 3).map((date) => ({ date, minutes: 1_000 })),
    );
    await t.http().get('/me/cosmetics').set(ada.auth).expect(200);
    await t
      .http()
      .put('/me/equipment/decoration')
      .set(ada.auth)
      .send({ cosmeticId: 'stone-lantern' })
      .expect(200);
    await t
      .http()
      .put('/me/badges/showcase')
      .set(ada.auth)
      .send({ badgeIds: ['first-session'] })
      .expect(200);
    const body = await collection(bob);
    expect(body.sections.map((s) => [s.kind, s.owned])).toEqual([
      ['species', 1],
      ['badges', 0],
      ['cosmetics', 2],
    ]);
    expect(item(body, 'cosmetics', 'stone-lantern')).toMatchObject({
      owned: false,
      equipped: false,
    });
    expect(item(body, 'badges', 'first-session')).toMatchObject({
      owned: false,
      showcasePosition: null,
    });
    expect(item(body, 'badges', 'focus-hours:10')?.unlock?.current).toBe(0);
  });

  it('reconciles a pre-A4.3 badge owner’s rewards, without an unlock event or Core change', async () => {
    const ada = await t.signUp('ada@example.com');
    await seed(
      ada,
      dateRange('2026-09-01', 7).map((date) => ({ date, minutes: 100 })),
    );
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
    const body = await collection(ada);
    for (const id of ['oak', 'sakura', 'pine']) {
      expect(item(body, 'species', id)).toMatchObject({ owned: true, ownedAt: NOW });
    }
    expect(await digest(CORE)).toEqual(core);
    expect(await collection(ada)).toEqual(body);
    const session = await t.submit(ada, '2026-10-07T10:00:00.000Z', 20).expect(201);
    expect((session.body as { progression: unknown }).progression).toEqual({
      newlyEarnedBadges: [],
      newlyUnlockedSpecies: [],
      newlyUnlockedCosmetics: [],
    });
  });

  it('requires authentication', async () => {
    await t.http().get('/me/collection').expect(401);
  });
});
