import { randomUUID } from 'node:crypto';

import { addDays, type LocalDate } from '../../src/common/local-date.js';
import { Prisma, type FocusSessionStatus } from '../../src/generated/prisma/client.js';
import { AchievementsService } from '../../src/progression/achievements.service.js';
import { ConsistencyHarness, dateRange } from '../support/consistency-harness.js';

/**
 * A4.2 achievements, badges, and the showcase (HTTP + PostgreSQL): progress derived from Core
 * truth, permanent grants after a counted session, the unlock result stored with the session,
 * lazy reconciliation for existing users, and the badges a month's recap snapshots at archive.
 */

const MIN = 60_000;
/** An action that caused nothing (A4.3 adds the reward lists). */
const NOTHING = { newlyEarnedBadges: [], newlyUnlockedSpecies: [], newlyUnlockedCosmetics: [] };
const NOW = '2026-10-07T20:00:00.000Z';
const t = new ConsistencyHarness(NOW);

type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

interface BadgeBody {
  id: string;
  name: string;
  description: string;
  category: string;
  rarity: string;
  artworkId: string;
  earnedAt: string;
}

interface Submitted {
  id: string;
  counted: boolean;
  progression: { newlyEarnedBadges: BadgeBody[] } | null;
}

interface AchievementBody {
  id: string;
  badge: Omit<BadgeBody, 'earnedAt'>;
  unit: string;
  current: number;
  target: number;
  completed: boolean;
  earnedAt: string | null;
  progressVisible: boolean;
}

interface BadgesBody {
  items: BadgeBody[];
  showcase: BadgeBody[];
}

interface RecapBody {
  badges: BadgeBody[];
  [key: string]: unknown;
}

/** Stores a session directly, as the server would have before A4.2 (no grant, no result). */
async function seed(
  user: User,
  rows: { date: LocalDate; minutes: number; status?: FocusSessionStatus; createdAt?: string }[],
): Promise<void> {
  for (const { date, minutes, status = 'completed', createdAt } of rows) {
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
        createdAt: new Date(createdAt ?? endedAt.toISOString()),
      },
    });
  }
}

const submit = async (user: User, startedAt: string, minutes: number, id = randomUUID()) => {
  const res = await t.submit(user, startedAt, minutes, id);
  return { status: res.status, body: res.body as Submitted };
};
const newly = (body: Submitted) => body.progression?.newlyEarnedBadges.map((b) => b.id);
const get = async <T>(user: User, path: string, status = 200) =>
  (await t.http().get(path).set(user.auth).expect(status)).body as T;
const achievements = (user: User) =>
  get<{ items: AchievementBody[] }>(user, '/me/achievements').then((body) => body.items);
const achievement = async (user: User, id: string) =>
  (await achievements(user)).find((a) => a.id === id);
const badges = (user: User) => get<BadgesBody>(user, '/me/badges');
const owned = (userId: string) =>
  t.prisma.userBadge.findMany({
    where: { userId },
    orderBy: [{ earnedAt: 'asc' }, { badgeId: 'asc' }],
  });
const ownedIds = async (userId: string) => (await owned(userId)).map((row) => row.badgeId);
const showcase = (user: User, badgeIds: unknown) =>
  t.http().put('/me/badges/showcase').set(user.auth).send({ badgeIds });

/** A digest of every Core table of the user: what reconciliation must never change. */
async function coreDigest(): Promise<Record<string, string>> {
  const tables = [
    'focus_sessions',
    'monthly_trees',
    'monthly_tree_traits',
    'monthly_recaps',
    'month_attribution_contexts',
    'streak_recoveries',
    'rest_days',
    'users',
  ];
  const digest: Record<string, string> = {};
  for (const table of tables) {
    const [row] = await t.prisma.$queryRawUnsafe<{ md5: string | null }[]>(
      `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS md5 FROM "${table}" t`,
    );
    digest[table] = row?.md5 ?? 'empty';
  }
  return digest;
}

/** Test-only content outside the seeded catalog. */
async function testAchievement(
  id: string,
  badge: { category?: string; rarity?: string; source?: string; status?: string },
  criterion: 'counted_sessions' | 'focused_minutes' | 'longest_streak_days' = 'counted_sessions',
  target = 1,
) {
  await t.prisma.badgeDefinition.create({
    data: {
      id,
      category: (badge.category ?? 'focus') as 'focus',
      rarity: (badge.rarity ?? 'common') as 'common',
      source: (badge.source ?? 'achievement') as 'achievement',
      availability: 'permanent',
      status: (badge.status ?? 'active') as 'active',
      name: `Badge ${id}`,
      description: 'For tests.',
      artworkId: id,
      sortOrder: 500,
    },
  });
  await t.prisma.achievementDefinition.create({
    data: { id, badgeId: id, criterion, target, progressVisible: true },
  });
}

describe('A4.2 achievements, badges, and showcase (HTTP + PostgreSQL)', () => {
  let service: AchievementsService;

  beforeAll(async () => {
    await t.start();
    service = t.app.get(AchievementsService);
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow(NOW);
    await t.activateConfig();
  });

  describe('evaluation after a session', () => {
    it('grants First Session with the first counted session, caused by it and earned now', async () => {
      const ada = await t.signUp('ada@example.com');
      const { status, body } = await submit(ada, '2026-10-07T18:00:00.000Z', 25);
      expect(status).toBe(201);
      expect(body.progression).toEqual({
        newlyEarnedBadges: [
          {
            id: 'first-session',
            name: 'First Session',
            description: 'Your first counted focus session.',
            category: 'focus',
            rarity: 'common',
            artworkId: 'first-session',
            earnedAt: NOW,
          },
        ],
        // A4.3: First Session also unlocks the Oak species.
        newlyUnlockedSpecies: [expect.objectContaining({ id: 'oak', unlockedAt: NOW }) as unknown],
        newlyUnlockedCosmetics: [],
      });
      expect(await owned(ada.userId)).toEqual([
        { userId: ada.userId, badgeId: 'first-session', earnedAt: new Date(NOW) },
      ]);
    });

    it('ignores a discarded session: it stays in history and counts for nothing', async () => {
      const ada = await t.signUp('ada@example.com');
      const { status, body } = await submit(ada, '2026-10-07T18:00:00.000Z', 3);
      expect(status).toBe(201);
      expect(body.counted).toBe(false);
      expect(body.progression).toEqual(NOTHING);
      expect(await ownedIds(ada.userId)).toEqual([]);
      expect(await achievement(ada, 'first-session')).toMatchObject({
        current: 0,
        completed: false,
      });
    });

    it('evaluates nothing for a rejected session: no row, no ownership', async () => {
      const ada = await t.signUp('ada@example.com');
      const res = await t.submit(ada, '2026-10-08T18:00:00.000Z', 25);
      expect(res.status).toBe(422);
      expect(await t.prisma.focusSession.count()).toBe(0);
      expect(await t.prisma.userBadge.count()).toBe(0);
    });

    it('grants 10 hours at exactly 600 counted minutes, not at 599', async () => {
      const ada = await t.signUp('ada@example.com');
      await seed(ada, [
        { date: '2026-10-01', minutes: 300 },
        { date: '2026-10-02', minutes: 289 },
        { date: '2026-10-03', minutes: 10, status: 'discarded' },
      ]);
      const below = await submit(ada, '2026-10-07T10:00:00.000Z', 10);
      // First Session was already reached before A4.2: granted now, not caused by this session.
      expect(newly(below.body)).toEqual([]);
      expect(await ownedIds(ada.userId)).toEqual(['first-session']);
      expect(await achievement(ada, 'focus-hours:10')).toMatchObject({
        current: 599,
        target: 600,
        completed: false,
        earnedAt: null,
      });

      const bob = await t.signUp('bob@example.com');
      await seed(bob, [{ date: '2026-10-01', minutes: 595 }]);
      const exactly = await submit(bob, '2026-10-07T10:00:00.000Z', 5);
      expect(newly(exactly.body)).toEqual(['focus-hours:10']);
      expect(await achievement(bob, 'focus-hours:10')).toMatchObject({
        current: 600,
        completed: true,
        earnedAt: NOW,
      });
    });

    it('grants above the threshold too, and several thresholds at once', async () => {
      const ada = await t.signUp('ada@example.com');
      await seed(ada, [
        { date: '2026-10-01', minutes: 1_000 },
        { date: '2026-10-02', minutes: 1_000 },
        { date: '2026-10-03', minutes: 990 },
      ]);
      await t.prisma.userBadge.createMany({
        data: [
          {
            userId: ada.userId,
            badgeId: 'first-session',
            earnedAt: new Date('2026-10-01T09:00:00.000Z'),
          },
          {
            userId: ada.userId,
            badgeId: 'focus-hours:10',
            earnedAt: new Date('2026-10-01T09:00:00.000Z'),
          },
        ],
      });
      const { body } = await submit(ada, '2026-10-07T10:00:00.000Z', 45);
      expect(newly(body)).toEqual(['focus-hours:50']);
      expect(await achievement(ada, 'focus-hours:50')).toMatchObject({ current: 3_035 });
    });

    it.each([3, 7, 30, 100])(
      'grants the %i-day streak on the day the run reaches it',
      async (days) => {
        const ada = await t.signUp('ada@example.com');
        const start = addDays('2026-10-07', -(days - 1));
        await seed(
          ada,
          dateRange(start, days - 1).map((date) => ({ date, minutes: 15 })),
        );
        const { body } = await submit(ada, '2026-10-07T10:00:00.000Z', 15);
        expect(newly(body)).toEqual([`focus-streak:${days}`]);
        // Shorter streak badges were reached before: granted with it, never as caused by it.
        const smaller = [3, 7, 30, 100].filter((d) => d < days).map((d) => `focus-streak:${d}`);
        expect((await ownedIds(ada.userId)).filter((id) => id.startsWith('focus-streak'))).toEqual(
          expect.arrayContaining([...smaller, `focus-streak:${days}`]),
        );
        expect(await achievement(ada, `focus-streak:${days}`)).toMatchObject({
          current: days,
          completed: true,
        });
      },
    );

    it('uses the longest streak: a 7-day run long ago still earns the badge', async () => {
      const ada = await t.signUp('ada@example.com');
      await seed(
        ada,
        dateRange('2026-08-01', 7).map((date) => ({ date, minutes: 20 })),
      );
      const streak = await get<{ current: number; longest: number }>(ada, '/me/streak');
      expect(streak).toMatchObject({ current: 0, longest: 7 });
      expect(await achievement(ada, 'focus-streak:7')).toMatchObject({
        current: 7,
        completed: true,
      });
    });

    it('never grants planned, Social, Event, time-based, or special-category badges', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.prisma.achievementDefinition.create({
        data: {
          id: 'focus-together:first',
          badgeId: 'focus-together:first',
          criterion: 'counted_sessions',
          target: 1,
        },
      });
      await testAchievement('social-active', { category: 'social' });
      await testAchievement('event-badge', { category: 'event', source: 'event' });
      await testAchievement('early-bird', { category: 'time_based' });
      await testAchievement('rare-category', { category: 'rare' });
      await testAchievement('rare-rarity', { category: 'focus', rarity: 'rare' });

      const { body } = await submit(ada, '2026-10-07T18:00:00.000Z', 25);
      expect(newly(body)).toEqual(['first-session', 'rare-rarity']);
      expect(await ownedIds(ada.userId)).toEqual(['first-session', 'rare-rarity']);
      // Hidden until their phase: not shown as progress the user could make now.
      const listed = (await achievements(ada)).map((a) => a.id);
      for (const id of [
        'focus-together:first',
        'social-active',
        'event-badge',
        'early-bird',
        'rare-category',
      ]) {
        expect(listed).not.toContain(id);
      }
      // Category "rare" and rarity "rare" are different things.
      const rare = (await badges(ada)).items.find((b) => b.id === 'rare-rarity');
      expect(rare).toMatchObject({ category: 'focus', rarity: 'rare' });
    });

    it('keeps every user’s progress and ownership apart', async () => {
      const ada = await t.signUp('ada@example.com');
      const bob = await t.signUp('bob@example.com');
      await submit(ada, '2026-10-07T18:00:00.000Z', 25);
      expect(await ownedIds(bob.userId)).toEqual([]);
      expect(await achievement(bob, 'first-session')).toMatchObject({
        current: 0,
        completed: false,
      });
      expect((await badges(bob)).items).toEqual([]);

      const { body } = await submit(bob, '2026-10-07T18:00:00.000Z', 25);
      expect(newly(body)).toEqual(['first-session']);
    });
  });

  describe('replay and exactly-once unlock results', () => {
    it('replays the stored result: the same badges, no new ownership, nothing new later', async () => {
      const ada = await t.signUp('ada@example.com');
      const id = randomUUID();
      const first = await submit(ada, '2026-10-07T18:00:00.000Z', 25, id);
      // The response was lost: the app sends the same session again.
      const replay = await submit(ada, '2026-10-07T18:00:00.000Z', 25, id);
      expect(replay.status).toBe(200);
      expect(replay.body.progression).toEqual(first.body.progression);
      expect(await t.prisma.userBadge.count({ where: { userId: ada.userId } })).toBe(1);

      // A later session never reports a badge already owned, only what it crossed itself.
      const second = await submit(ada, '2026-10-07T07:00:00.000Z', 610);
      expect(newly(second.body)).toEqual(['focus-hours:10']);
      // And the first session's replay still answers what it caused, unchanged: never what
      // was earned since, never inferred from earned times.
      expect((await submit(ada, '2026-10-07T18:00:00.000Z', 25, id)).body.progression).toEqual(
        first.body.progression,
      );
    });

    it('answers null for a session stored before A4.2: nothing is fabricated', async () => {
      const ada = await t.signUp('ada@example.com');
      const id = randomUUID();
      await submit(ada, '2026-10-07T18:00:00.000Z', 25, id);
      await t.prisma.focusSession.update({
        where: { userId_id: { userId: ada.userId, id } },
        data: { progressionResult: Prisma.DbNull },
      });
      expect((await submit(ada, '2026-10-07T18:00:00.000Z', 25, id)).body.progression).toBeNull();
    });

    it('grants a threshold once when two sessions cross it concurrently', async () => {
      const ada = await t.signUp('ada@example.com');
      await seed(ada, [{ date: '2026-10-01', minutes: 590 }]);
      await t.prisma.userBadge.create({
        data: {
          userId: ada.userId,
          badgeId: 'first-session',
          earnedAt: new Date('2026-10-01T09:00:00.000Z'),
        },
      });
      const results = await Promise.all([
        submit(ada, '2026-10-07T10:00:00.000Z', 15),
        submit(ada, '2026-10-07T11:00:00.000Z', 15),
      ]);
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      const reports = results.flatMap((r) => newly(r.body) ?? []);
      expect(reports).toEqual(['focus-hours:10']);
      expect(await t.prisma.userBadge.count({ where: { badgeId: 'focus-hours:10' } })).toBe(1);
    });

    it('grants once when evaluations race, and repeated reconciliation changes nothing', async () => {
      const ada = await t.signUp('ada@example.com');
      await seed(
        ada,
        dateRange('2026-09-01', 7).map((date) => ({ date, minutes: 100 })),
      );
      const results = await Promise.all(
        Array.from({ length: 8 }, () => service.reconcile(ada.userId)),
      );
      // A4.3: an evaluation answers its badges and the rewards linked to them.
      const granted = results
        .flatMap((r) => r.badges)
        .map((g) => g.badgeId)
        .sort();
      expect(granted).toEqual([
        'first-session',
        'focus-hours:10',
        'focus-streak:3',
        'focus-streak:7',
      ]);
      const before = await owned(ada.userId);
      expect(before).toHaveLength(4);
      await achievements(ada);
      await badges(ada);
      expect(await service.reconcile(ada.userId)).toEqual({
        badges: [],
        species: [],
        cosmetics: [],
      });
      expect(await owned(ada.userId)).toEqual(before);
    });
  });

  describe('existing users (Core history before A4.2)', () => {
    it('grants what history already earned, dated honestly, without touching Core data', async () => {
      const ada = await t.signUp('ada@example.com');
      // Seven days of 100 minutes in September, each stored at the end of its session.
      await seed(
        ada,
        dateRange('2026-09-01', 7).map((date) => ({ date, minutes: 100 })),
      );
      const core = await coreDigest();

      const list = await achievements(ada);
      const byId = new Map(list.map((a) => [a.id, a]));
      // Derived from the stored sessions: the session that crossed each threshold, as stored.
      expect(byId.get('first-session')?.earnedAt).toBe('2026-09-01T09:40:00.000Z');
      expect(byId.get('focus-hours:10')?.earnedAt).toBe('2026-09-06T09:40:00.000Z');
      // A streak cannot be replayed as it stood then: the time of this reconciliation.
      expect(byId.get('focus-streak:3')?.earnedAt).toBe(NOW);
      expect(byId.get('focus-streak:7')?.earnedAt).toBe(NOW);
      expect(byId.get('focus-hours:50')).toMatchObject({
        current: 700,
        completed: false,
        earnedAt: null,
      });
      expect(await coreDigest()).toEqual(core);
    });
  });

  describe('achievements and badges queries', () => {
    it('lists earnable achievements in catalog order with their badge and progress', async () => {
      const ada = await t.signUp('ada@example.com');
      const list = await achievements(ada);
      expect(list.map((a) => a.id)).toEqual([
        'first-session',
        'focus-hours:10',
        'focus-hours:50',
        'focus-hours:100',
        'focus-hours:500',
        'focus-streak:3',
        'focus-streak:7',
        'focus-streak:30',
        'focus-streak:100',
      ]);
      expect(list[0]).toEqual({
        id: 'first-session',
        badge: {
          id: 'first-session',
          name: 'First Session',
          description: 'Your first counted focus session.',
          category: 'focus',
          rarity: 'common',
          artworkId: 'first-session',
        },
        unit: 'sessions',
        current: 0,
        target: 1,
        completed: false,
        earnedAt: null,
        progressVisible: false,
      });
      expect(list[1]).toMatchObject({ unit: 'minutes', target: 600, progressVisible: true });
      expect(list[5]).toMatchObject({ unit: 'days', target: 3 });
    });

    it('keeps a retired badge the user owns as completed, and hides one they do not', async () => {
      const ada = await t.signUp('ada@example.com');
      await submit(ada, '2026-10-07T18:00:00.000Z', 25);
      await t.prisma.badgeDefinition.updateMany({
        where: { id: { in: ['first-session', 'focus-hours:500'] } },
        data: { status: 'retired' },
      });
      const list = await achievements(ada);
      expect(list.find((a) => a.id === 'first-session')).toMatchObject({
        completed: true,
        earnedAt: NOW,
      });
      expect(list.map((a) => a.id)).not.toContain('focus-hours:500');
      expect((await badges(ada)).items.map((b) => b.id)).toEqual(['first-session']);
    });

    it('lists owned badges in earned order with their definitions', async () => {
      const ada = await t.signUp('ada@example.com');
      await submit(ada, '2026-10-07T18:00:00.000Z', 25);
      expect(await badges(ada)).toEqual({
        items: [
          {
            id: 'first-session',
            name: 'First Session',
            description: 'Your first counted focus session.',
            category: 'focus',
            rarity: 'common',
            artworkId: 'first-session',
            earnedAt: NOW,
          },
        ],
        showcase: [],
      });
    });

    it('requires authentication', async () => {
      await t.http().get('/me/achievements').expect(401);
      await t.http().get('/me/badges').expect(401);
      await t.http().put('/me/badges/showcase').send({ badgeIds: [] }).expect(401);
    });
  });

  describe('badge showcase', () => {
    /** Owns first-session, focus-hours:10, focus-streak:3, focus-streak:7. */
    async function withFourBadges(email = 'ada@example.com') {
      const user = await t.signUp(email);
      await seed(
        user,
        dateRange('2026-09-01', 7).map((date) => ({ date, minutes: 100 })),
      );
      await badges(user);
      return user;
    }
    const ids = (body: BadgesBody) => body.showcase.map((b) => b.id);

    it('pins up to three owned badges in the user’s order, and clears', async () => {
      const ada = await withFourBadges();
      for (const pinned of [
        [],
        ['focus-streak:7'],
        ['focus-streak:7', 'first-session'],
        ['focus-hours:10', 'focus-streak:7', 'first-session'],
      ]) {
        const res = await showcase(ada, pinned).expect(200);
        expect(ids(res.body as BadgesBody)).toEqual(pinned);
        expect(ids(await badges(ada))).toEqual(pinned);
      }
      const res = await showcase(ada, []).expect(200);
      expect((res.body as BadgesBody).showcase).toEqual([]);
      expect(await t.prisma.badgeShowcase.count()).toBe(0);
    });

    it('answers the same body the same way (idempotent)', async () => {
      const ada = await withFourBadges();
      const a = await showcase(ada, ['focus-streak:3', 'first-session']).expect(200);
      const b = await showcase(ada, ['focus-streak:3', 'first-session']).expect(200);
      expect(b.body).toEqual(a.body);
    });

    it('refuses more than three, duplicates, and badges the user does not own, changing nothing', async () => {
      const ada = await withFourBadges();
      await showcase(ada, ['focus-streak:3']).expect(200);
      await showcase(ada, [
        'first-session',
        'focus-hours:10',
        'focus-streak:3',
        'focus-streak:7',
      ]).expect(400);
      await showcase(ada, ['first-session', 'first-session']).expect(400);
      await showcase(ada, 'first-session').expect(400);
      await showcase(ada, [3]).expect(400);
      const unowned = await showcase(ada, ['first-session', 'focus-hours:50']).expect(422);
      expect((unowned.body as { code: string }).code).toBe('badge_not_owned');
      const unknown = await showcase(ada, ['no-such-badge']).expect(422);
      expect((unknown.body as { code: string }).code).toBe('badge_not_owned');
      expect(ids(await badges(ada))).toEqual(['focus-streak:3']);
    });

    it('replaces the whole showcase at once', async () => {
      const ada = await withFourBadges();
      await showcase(ada, ['first-session', 'focus-streak:3']).expect(200);
      await showcase(ada, ['focus-streak:3', 'focus-hours:10']).expect(200);
      const rows = await t.prisma.badgeShowcase.findMany({
        where: { userId: ada.userId },
        orderBy: { position: 'asc' },
      });
      expect(rows.map((r) => [r.position, r.badgeId])).toEqual([
        [1, 'focus-streak:3'],
        [2, 'focus-hours:10'],
      ]);
      // Concurrent replacements leave one of them whole, never a mix.
      await Promise.all([
        showcase(ada, ['first-session', 'focus-streak:7', 'focus-hours:10']),
        showcase(ada, ['focus-streak:3']),
      ]);
      expect([
        ['first-session', 'focus-streak:7', 'focus-hours:10'],
        ['focus-streak:3'],
      ]).toContainEqual(ids(await badges(ada)));
    });

    it('keeps users apart: another user’s badge cannot be pinned or seen', async () => {
      const ada = await withFourBadges();
      const bob = await t.signUp('bob@example.com');
      await showcase(ada, ['first-session']).expect(200);
      await showcase(bob, ['first-session']).expect(422);
      expect(await badges(bob)).toEqual({ items: [], showcase: [] });
      expect(ids(await badges(ada))).toEqual(['first-session']);
    });

    it('is enforced by the database too: only owned badges, at most three positions', async () => {
      const ada = await withFourBadges();
      await expect(
        t.prisma.badgeShowcase.create({
          data: { userId: ada.userId, badgeId: 'focus-hours:50', position: 1 },
        }),
      ).rejects.toThrow();
      await expect(
        t.prisma.badgeShowcase.create({
          data: { userId: ada.userId, badgeId: 'first-session', position: 4 },
        }),
      ).rejects.toThrow();
      await t.prisma.badgeShowcase.create({
        data: { userId: ada.userId, badgeId: 'first-session', position: 1 },
      });
      await expect(
        t.prisma.badgeShowcase.create({
          data: { userId: ada.userId, badgeId: 'focus-streak:3', position: 1 },
        }),
      ).rejects.toThrow();
      // Deleting the account removes everything, the showcase included.
      await t.prisma.user.delete({ where: { id: ada.userId } });
      expect(await t.prisma.badgeShowcase.count()).toBe(0);
    });
  });

  describe('recap and archive badge snapshot', () => {
    it('snapshots the badges earned in the month, and never changes it afterwards', async () => {
      const ada = await t.signUp('ada@example.com', 'UTC', '2026-08-15T00:00:00.000Z');
      for (const day of [1, 2, 3]) {
        await t.setNow(`2026-09-0${day}T20:00:00.000Z`);
        await submit(ada, `2026-09-0${day}T08:00:00.000Z`, 200);
      }
      await t.setNow('2026-10-02T09:00:00.000Z');
      await showcase(ada, ['focus-streak:3']).expect(200);
      const recap = await get<RecapBody>(ada, '/me/trees/2026/9/recap');
      expect(recap.badges.map((b) => [b.id, b.earnedAt])).toEqual([
        ['first-session', '2026-09-01T20:00:00.000Z'],
        ['focus-hours:10', '2026-09-03T20:00:00.000Z'],
        ['focus-streak:3', '2026-09-03T20:00:00.000Z'],
      ]);
      expect(recap.badges[0]).toEqual({
        id: 'first-session',
        name: 'First Session',
        description: 'Your first counted focus session.',
        category: 'focus',
        rarity: 'common',
        artworkId: 'first-session',
        earnedAt: '2026-09-01T20:00:00.000Z',
      });
      const details = await get<RecapBody>(ada, '/me/trees/2026/9');
      expect(details.badges).toEqual(recap.badges);
      const stored = await t.prisma.monthlyRecap.findUniqueOrThrow({
        where: { userId_year_month: { userId: ada.userId, year: 2026, month: 9 } },
      });
      expect((stored.content as { badges: unknown }).badges).toEqual([
        { badgeId: 'first-session', earnedAt: '2026-09-01T20:00:00.000Z' },
        { badgeId: 'focus-hours:10', earnedAt: '2026-09-03T20:00:00.000Z' },
        { badgeId: 'focus-streak:3', earnedAt: '2026-09-03T20:00:00.000Z' },
      ]);

      // Showcase changes and new badges later never reach the archived month.
      await showcase(ada, ['first-session']).expect(200);
      await t.setNow('2026-10-04T20:00:00.000Z');
      await submit(ada, '2026-10-04T08:00:00.000Z', 30);
      expect(await get<RecapBody>(ada, '/me/trees/2026/9/recap')).toEqual(recap);
    });

    it('lets a late session earn a lifetime badge now, leaving the archive as it was', async () => {
      const ada = await t.signUp('ada@example.com', 'UTC', '2026-08-15T00:00:00.000Z');
      await t.setNow('2026-09-10T20:00:00.000Z');
      await submit(ada, '2026-09-10T08:00:00.000Z', 290);
      await t.setNow('2026-09-11T20:00:00.000Z');
      await submit(ada, '2026-09-11T08:00:00.000Z', 300);
      await t.setNow('2026-10-02T20:00:00.000Z');
      await submit(ada, '2026-10-02T08:00:00.000Z', 5);
      const recap = await get<RecapBody>(ada, '/me/trees/2026/9/recap');
      const tree = await get<RecapBody>(ada, '/me/trees/2026/9');
      const archived = await t.prisma.monthlyTree.findUniqueOrThrow({
        where: { userId_year_month: { userId: ada.userId, year: 2026, month: 9 } },
      });

      // A legitimate late September session (offline), after September was archived.
      await t.setNow('2026-10-03T20:00:00.000Z');
      const late = await submit(ada, '2026-09-29T08:00:00.000Z', 10);
      expect(late.status).toBe(201);
      expect(late.body).toMatchObject({ year: 2026, month: 9, counted: true });
      expect(newly(late.body)).toEqual(['focus-hours:10']);
      expect(await achievement(ada, 'focus-hours:10')).toMatchObject({
        completed: true,
        earnedAt: '2026-10-03T20:00:00.000Z',
      });
      expect(await get<RecapBody>(ada, '/me/trees/2026/9/recap')).toEqual(recap);
      expect(await get<RecapBody>(ada, '/me/trees/2026/9')).toEqual(tree);
      expect(
        await t.prisma.monthlyTree.findUniqueOrThrow({
          where: { userId_year_month: { userId: ada.userId, year: 2026, month: 9 } },
        }),
      ).toEqual(archived);

      // It belongs to the month it was earned in: October's recap has it.
      await t.setNow('2026-11-02T09:00:00.000Z');
      const october = await get<RecapBody>(ada, '/me/trees/2026/10/recap');
      expect(october.badges.map((b) => b.id)).toEqual(['focus-hours:10']);
    });

    it('keeps a recap from before A4.2 valid and empty, even when history earns badges later', async () => {
      const ada = await t.signUp('ada@example.com', 'UTC', '2026-08-15T00:00:00.000Z');
      await seed(
        ada,
        dateRange('2026-09-01', 7).map((date) => ({ date, minutes: 100 })),
      );
      await t.setNow('2026-10-02T09:00:00.000Z');
      const before = await get<RecapBody>(ada, '/me/trees/2026/9/recap');
      expect(before.badges).toEqual([]);
      // Reconciliation dates two badges in September (by their crossing sessions)…
      const list = await achievements(ada);
      expect(list.find((a) => a.id === 'first-session')?.earnedAt).toBe('2026-09-01T09:40:00.000Z');
      // …but the archived recap is a snapshot: it never gains them.
      expect(await get<RecapBody>(ada, '/me/trees/2026/9/recap')).toEqual(before);
      expect((await get<RecapBody>(ada, '/me/trees/2026/9')).badges).toEqual([]);
    });

    it('places a badge in the month of its own time zone, not the UTC month', async () => {
      // Asia/Ho_Chi_Minh is UTC+7: 2026-09-30T17:30Z is already 1 October there.
      const ada = await t.signUp('ada@example.com', 'Asia/Ho_Chi_Minh', '2026-08-15T00:00:00.000Z');
      await t.setNow('2026-09-29T03:00:00.000Z');
      await submit(ada, '2026-09-29T01:00:00.000Z', 30); // 29 Sep 08:00 local: First Session
      await t.setNow('2026-09-30T03:00:00.000Z');
      await submit(ada, '2026-09-30T01:00:00.000Z', 30); // 30 Sep 08:00 local
      await t.setNow('2026-09-30T17:50:00.000Z');
      const third = await submit(ada, '2026-09-30T17:10:00.000Z', 30); // 1 Oct 00:10 local
      expect(third.body).toMatchObject({ year: 2026, month: 10 });
      expect(newly(third.body)).toEqual(['focus-streak:3']);

      await t.setNow('2026-11-02T09:00:00.000Z');
      const september = await get<RecapBody>(ada, '/me/trees/2026/9/recap');
      const october = await get<RecapBody>(ada, '/me/trees/2026/10/recap');
      expect(september.badges.map((b) => b.id)).toEqual(['first-session']);
      expect(october.badges.map((b) => [b.id, b.earnedAt])).toEqual([
        ['focus-streak:3', '2026-09-30T17:50:00.000Z'],
      ]);
    });
  });
});
