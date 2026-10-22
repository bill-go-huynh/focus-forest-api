import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ContentNotFoundError,
  ProgressionOwnershipService,
} from '../../src/progression/progression-ownership.service.js';
import { ACHIEVEMENT_CRITERIA, isContentId } from '../../src/progression/progression-rules.js';
import type { TreeStateDto } from '../../src/trees/tree.contracts.js';
import { ConsistencyHarness, dateRange } from '../support/consistency-harness.js';

/**
 * A4.1 progression foundation (HTTP + PostgreSQL): content definitions as versioned seed data,
 * permanent ownership, the signature species owned by everyone, and Phase 3 compatibility.
 * Nothing here evaluates achievements or exposes an endpoint (A4.2–A4.4).
 */

const NOW = '2026-10-07T20:00:00.000Z';
const t = new ConsistencyHarness(NOW);
const at = new Date(NOW);

const MIGRATIONS = 'prisma/migrations';
const migrationDir = readdirSync(MIGRATIONS).find((name) =>
  name.endsWith('_progression_foundation'),
);
const migrationSql = readFileSync(
  join(MIGRATIONS, migrationDir ?? 'missing', 'migration.sql'),
  'utf8',
);

describe('A4.1 progression foundation (HTTP + PostgreSQL)', () => {
  let ownership: ProgressionOwnershipService;

  beforeAll(async () => {
    await t.start();
    ownership = t.app.get(ProgressionOwnershipService);
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow(NOW);
    await t.activateConfig();
  });

  /** A badge granted by an achievement, and a species and a cosmetic it unlocks (test content). */
  async function rewardContent(prefix = 'test') {
    await t.prisma.badgeDefinition.create({
      data: {
        id: `${prefix}-badge`,
        category: 'focus',
        rarity: 'rare',
        source: 'achievement',
        availability: 'permanent',
        status: 'active',
        name: 'Test badge',
        description: 'For tests.',
        artworkId: `${prefix}-badge`,
      },
    });
    await t.prisma.achievementDefinition.create({
      data: {
        id: `${prefix}-achievement`,
        badgeId: `${prefix}-badge`,
        criterion: 'focused_minutes',
        target: 600,
        progressVisible: true,
      },
    });
    await t.prisma.treeSpecies.create({
      data: {
        id: `${prefix}-species`,
        rarity: 'rare',
        source: 'achievement',
        achievementId: `${prefix}-achievement`,
        availability: 'permanent',
        status: 'active',
        name: 'Test species',
        description: 'For tests.',
      },
    });
    await t.prisma.cosmeticDefinition.create({
      data: {
        id: `${prefix}-lantern`,
        type: 'decoration',
        rarity: 'common',
        source: 'achievement',
        achievementId: `${prefix}-achievement`,
        availability: 'permanent',
        status: 'active',
        name: 'Test lantern',
        description: 'For tests.',
        artworkId: `${prefix}-lantern`,
      },
    });
  }

  const sqlError = async (body: () => Promise<unknown>) => {
    try {
      await body();
    } catch (error) {
      return error;
    }
    return null;
  };

  describe('content definitions', () => {
    it('seeds a reviewable catalog with stable, unique, valid identifiers', async () => {
      const badges = await t.prisma.badgeDefinition.findMany({ orderBy: { sortOrder: 'asc' } });
      const achievements = await t.prisma.achievementDefinition.findMany();
      const species = await t.prisma.treeSpecies.findMany({ orderBy: { sortOrder: 'asc' } });
      for (const id of [...badges, ...achievements, ...species].map((row) => row.id)) {
        expect(isContentId(id)).toBe(true);
      }
      expect(badges.map((b) => b.id)).toEqual([
        'first-session',
        'focus-hours:10',
        'focus-hours:50',
        'focus-hours:100',
        'focus-hours:500',
        'focus-streak:3',
        'focus-streak:7',
        'focus-streak:30',
        'focus-streak:100',
        'early-bird',
        'night-owl',
        'weekend-warrior',
        'focus-together:first',
        'focus-buddy',
      ]);
      // A4.3 seeds the other species in its own migration; the signature species stays first.
      expect(species[0]?.id).toBe('signature');
      // Each achievement grants exactly one badge, by a criterion this product supports.
      expect(new Set(achievements.map((a) => a.badgeId)).size).toBe(achievements.length);
      for (const achievement of achievements) {
        expect(ACHIEVEMENT_CRITERIA).toContain(achievement.criterion);
        expect(achievement.target).toBeGreaterThan(0);
      }
      expect(Object.fromEntries(achievements.map((a) => [a.id, [a.criterion, a.target]]))).toEqual({
        'first-session': ['counted_sessions', 1],
        'focus-hours:10': ['focused_minutes', 600],
        'focus-hours:50': ['focused_minutes', 3000],
        'focus-hours:100': ['focused_minutes', 6000],
        'focus-hours:500': ['focused_minutes', 30000],
        'focus-streak:3': ['longest_streak_days', 3],
        'focus-streak:7': ['longest_streak_days', 7],
        'focus-streak:30': ['longest_streak_days', 30],
        'focus-streak:100': ['longest_streak_days', 100],
        // A5.4.
        'focus-together:first': ['focus_together_sessions', 1],
        'focus-buddy': ['focus_together_with_friend', 1],
        // Owner decision 2026-10-15.
        'early-bird': ['sessions_before_7', 10],
        'night-owl': ['sessions_after_22', 10],
        'weekend-warrior': ['full_weekends', 4],
      });
      // Every active badge from an achievement has one; planned ones need none yet.
      const granting = new Set(achievements.map((a) => a.badgeId));
      for (const badge of badges.filter((b) => b.status === 'active')) {
        expect(badge.source === 'achievement' && granting.has(badge.id)).toBe(true);
      }
    });

    // A4.1 defined the Social badges as planned; A5.4 makes the Focus Together ones earnable.
    // Community Contributor was removed with the Community Tree (owner, 2026-10-22).
    it('makes every Social badge earnable, each by its own achievement', async () => {
      const social = await t.prisma.badgeDefinition.findMany({
        where: { category: 'social' },
        orderBy: { sortOrder: 'asc' },
      });
      expect(social.map((b) => [b.id, b.status])).toEqual([
        ['focus-together:first', 'active'],
        ['focus-buddy', 'active'],
      ]);
      expect(
        await t.prisma.achievementDefinition.count({
          where: { badgeId: 'community-contributor' },
        }),
      ).toBe(0);
    });

    it('rejects invalid identifiers, values, and references', async () => {
      const badge = (id: string, extra: Record<string, unknown> = {}) =>
        t.prisma.badgeDefinition.create({
          data: {
            id,
            category: 'focus',
            rarity: 'common',
            source: 'achievement',
            availability: 'permanent',
            status: 'planned',
            name: 'x',
            description: 'x',
            artworkId: 'x',
            ...extra,
          },
        });
      expect(await sqlError(() => badge('Focus Hours'))).not.toBeNull();
      expect(await sqlError(() => badge('badge.first_session'))).not.toBeNull();
      // Permanent content has no end; limited content needs one.
      expect(
        await sqlError(() => badge('ends', { availableUntil: new Date('2027-01-01') })),
      ).not.toBeNull();
      expect(await sqlError(() => badge('no-end', { availability: 'limited' }))).not.toBeNull();
      expect(await sqlError(() => badge('blank-name', { name: ' ' }))).not.toBeNull();
      // References must exist.
      expect(
        await sqlError(() =>
          t.prisma.achievementDefinition.create({
            data: { id: 'orphan', badgeId: 'missing', criterion: 'counted_sessions', target: 1 },
          }),
        ),
      ).not.toBeNull();
      expect(
        await sqlError(() =>
          t.prisma.achievementDefinition.create({
            data: { id: 'zero', badgeId: 'focus-buddy', criterion: 'counted_sessions', target: 0 },
          }),
        ),
      ).not.toBeNull();
      // A badge is granted by one achievement at most.
      expect(
        await sqlError(() =>
          t.prisma.achievementDefinition.create({
            data: {
              id: 'twice',
              badgeId: 'first-session',
              criterion: 'counted_sessions',
              target: 2,
            },
          }),
        ),
      ).not.toBeNull();
      // An achievement source names its achievement; no other source does.
      expect(
        await sqlError(() =>
          t.prisma.cosmeticDefinition.create({
            data: {
              id: 'no-source',
              type: 'background',
              rarity: 'common',
              source: 'achievement',
              availability: 'permanent',
              status: 'planned',
              name: 'x',
              description: 'x',
              artworkId: 'x',
            },
          }),
        ),
      ).not.toBeNull();
      expect(
        await sqlError(() =>
          t.prisma.treeSpecies.create({
            data: {
              id: 'golden-ghost',
              baseSpeciesId: 'missing',
              rarity: 'rare',
              source: 'season',
              availability: 'permanent',
              status: 'planned',
              name: 'x',
              description: 'x',
            },
          }),
        ),
      ).not.toBeNull();
    });

    it('keeps shipped identifiers: never renamed, and never deleted once referenced', async () => {
      expect(
        await sqlError(() =>
          t.prisma.badgeDefinition.update({
            where: { id: 'focus-buddy' },
            data: { id: 'focus-friend' },
          }),
        ),
      ).not.toBeNull();
      expect(
        await sqlError(() => t.prisma.badgeDefinition.delete({ where: { id: 'first-session' } })),
      ).not.toBeNull();
      // Copy and availability may change; the id stays.
      await t.prisma.badgeDefinition.update({
        where: { id: 'focus-buddy' },
        data: { description: 'Reworded.' },
      });
    });
  });

  describe('badge ownership', () => {
    it('is granted once: a repeated grant changes nothing', async () => {
      const ada = await t.signUp('ada@example.com');
      const first = await ownership.grantBadge(ada.userId, 'first-session', at);
      const again = await ownership.grantBadge(
        ada.userId,
        'first-session',
        new Date('2026-10-09T00:00:00.000Z'),
      );
      expect(first).toEqual({ granted: true, earnedAt: at });
      expect(again).toEqual({ granted: false, earnedAt: at });
      expect(await t.prisma.userBadge.count()).toBe(1);
    });

    it('creates one ownership when the same grant arrives ten times at once', async () => {
      const ada = await t.signUp('ada@example.com');
      const results = await Promise.all(
        Array.from({ length: 10 }, () => ownership.grantBadge(ada.userId, 'focus-hours:10', at)),
      );
      expect(results.filter((r) => r.granted)).toHaveLength(1);
      expect(await t.prisma.userBadge.count()).toBe(1);
    });

    it('belongs to its user', async () => {
      const ada = await t.signUp('ada@example.com');
      const bob = await t.signUp('bob@example.com');
      await ownership.grantBadge(ada.userId, 'first-session', at);
      expect(await ownership.ownedBadgeIds(ada.userId)).toEqual(['first-session']);
      expect(await ownership.ownedBadgeIds(bob.userId)).toEqual([]);
    });

    it('is permanent: retiring the badge stops new grants, never removes ownership', async () => {
      const ada = await t.signUp('ada@example.com');
      const bob = await t.signUp('bob@example.com');
      await ownership.grantBadge(ada.userId, 'focus-streak:3', at);
      await t.prisma.badgeDefinition.update({
        where: { id: 'focus-streak:3' },
        data: { status: 'retired' },
      });
      expect(await ownership.ownedBadgeIds(ada.userId)).toEqual(['focus-streak:3']);
      await expect(ownership.grantBadge(bob.userId, 'focus-streak:3', at)).rejects.toMatchObject({
        reason: 'not_active',
      });
      // The row itself cannot be changed.
      expect(
        await sqlError(() =>
          t.prisma.userBadge.updateMany({ data: { earnedAt: new Date('2020-01-01') } }),
        ),
      ).not.toBeNull();
    });

    it('refuses unknown badges', async () => {
      const ada = await t.signUp('ada@example.com');
      await expect(ownership.grantBadge(ada.userId, 'no-such-badge', at)).rejects.toBeInstanceOf(
        ContentNotFoundError,
      );
    });
  });

  describe('species', () => {
    it('has the signature species, owned by every user, new or existing, without a grant', async () => {
      const signature = await t.prisma.treeSpecies.findUniqueOrThrow({
        where: { id: 'signature' },
      });
      expect(signature).toMatchObject({ source: 'system', status: 'active', baseSpeciesId: null });
      const ada = await t.signUp('ada@example.com');
      expect(await ownership.ownsSpecies(ada.userId, 'signature')).toBe(true);
      expect(await ownership.ownedSpeciesIds(ada.userId)).toEqual(['signature']);
      expect(await t.prisma.userSpecies.count()).toBe(0);
    });

    it('keeps the signature species owned forever: it cannot be retired, re-sourced, or removed', async () => {
      for (const data of [{ status: 'retired' as const }, { source: 'achievement' as const }]) {
        expect(
          await sqlError(() => t.prisma.treeSpecies.update({ where: { id: 'signature' }, data })),
        ).not.toBeNull();
      }
      expect(
        await sqlError(() => t.prisma.treeSpecies.delete({ where: { id: 'signature' } })),
      ).not.toBeNull();
    });

    it('keeps Phase 3 trees valid: they name the signature species, and no unknown one', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(
        ada,
        dateRange('2026-09-21', 5).map((d) => [d, 60] as [string, number]),
      );
      await t.http().get('/me/trees/current').set(ada.auth).expect(200);
      await t.setNow('2026-10-02T12:00:00.000Z');
      const home = (await t.http().get('/me/home').set(ada.auth).expect(200)).body as {
        tree: TreeStateDto;
      };
      expect(home.tree.species).toBe('signature');
      const archived = (await t.http().get('/me/trees/2026/9').set(ada.auth).expect(200)).body as {
        kind: string;
        tree: TreeStateDto;
      };
      expect(archived).toMatchObject({ kind: 'archived', tree: { species: 'signature' } });
      // A tree can only name a defined species.
      expect(
        await sqlError(
          () =>
            t.prisma
              .$executeRaw`UPDATE monthly_trees SET species = 'nowhere' WHERE status = 'growing'`,
        ),
      ).not.toBeNull();
    });

    it('grants an unlocked species once, under concurrency, and keeps it when availability ends', async () => {
      await rewardContent();
      const ada = await t.signUp('ada@example.com');
      const results = await Promise.all(
        Array.from({ length: 8 }, () => ownership.grantSpecies(ada.userId, 'test-species', at)),
      );
      expect(results.filter((r) => r.granted)).toHaveLength(1);
      await t.prisma.treeSpecies.update({
        where: { id: 'test-species' },
        data: { status: 'retired' },
      });
      expect(await ownership.ownsSpecies(ada.userId, 'test-species')).toBe(true);
      expect(await ownership.ownedSpeciesIds(ada.userId)).toEqual(['signature', 'test-species']);
    });

    it('has no growth rules of its own: every species shares the tree’s one framework', async () => {
      const columns = await t.prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tree_species'
        ORDER BY column_name`;
      expect(columns.map((c) => c.column_name)).toEqual([
        'achievement_id',
        'availability',
        'available_from',
        'available_until',
        'base_species_id',
        'created_at',
        'description',
        'id',
        'name',
        'rarity',
        'sort_order',
        'source',
        'status',
      ]);
    });
  });

  describe('cosmetics', () => {
    it('grants once under concurrency, never changes the tree, and carries no progression value', async () => {
      await rewardContent();
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [['2026-10-06', 50]]);
      const before = (await t.http().get('/me/trees/current').set(ada.auth).expect(200)).body as {
        tree: TreeStateDto;
      };
      const results = await Promise.all(
        Array.from({ length: 8 }, () => ownership.grantCosmetic(ada.userId, 'test-lantern', at)),
      );
      expect(results.filter((r) => r.granted)).toHaveLength(1);
      await ownership.grantBadge(ada.userId, 'test-badge', at);
      const after = (await t.http().get('/me/trees/current').set(ada.auth).expect(200)).body as {
        tree: TreeStateDto;
      };
      expect(after.tree).toEqual(before.tree);
      const columns = await t.prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('user_badges', 'user_species', 'user_cosmetics')
        ORDER BY table_name, column_name`;
      expect(columns.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
        'user_badges.badge_id',
        'user_badges.earned_at',
        'user_badges.user_id',
        'user_cosmetics.cosmetic_id',
        'user_cosmetics.unlocked_at',
        'user_cosmetics.user_id',
        'user_species.species_id',
        'user_species.unlocked_at',
        'user_species.user_id',
      ]);
    });

    // Events exist from A5.6, seasons from A5.9: both are acquirable within their windows.
    it('opens season cosmetics within their window from A5.9', async () => {
      await t.prisma.cosmeticDefinition.create({
        data: {
          id: 'harvest-lantern',
          type: 'decoration',
          rarity: 'rare',
          source: 'season',
          availability: 'limited',
          availableFrom: new Date('2026-10-01'),
          availableUntil: new Date('2026-11-01'),
          status: 'active',
          name: 'Harvest lantern',
          description: 'x',
          artworkId: 'harvest-lantern',
        },
      });
      const ada = await t.signUp('ada@example.com');
      await expect(
        ownership.grantCosmetic(ada.userId, 'harvest-lantern', at),
      ).resolves.toMatchObject({
        granted: true,
      });
      await expect(
        ownership.grantCosmetic(ada.userId, 'harvest-lantern', new Date('2026-11-01')),
      ).resolves.toMatchObject({ granted: false });
    });
  });

  describe('collection foundation', () => {
    it('joins every owned item to its definition, and tells locked items apart, with no stored book', async () => {
      await rewardContent();
      const ada = await t.signUp('ada@example.com');
      await ownership.grantBadge(ada.userId, 'first-session', at);
      await ownership.grantCosmetic(ada.userId, 'test-lantern', at);
      const badges = await t.prisma.badgeDefinition.findMany({
        include: { owners: { where: { userId: ada.userId } } },
        orderBy: { sortOrder: 'asc' },
      });
      const owned = badges.filter((b) => b.owners.length > 0).map((b) => b.id);
      expect(owned).toEqual(['first-session']);
      expect(badges.filter((b) => b.owners.length === 0).length).toBe(badges.length - 1);
      const tables = await t.prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name ILIKE '%collection%'`;
      expect(tables).toEqual([]);
    });
  });

  describe('historical compatibility', () => {
    it('adds the foundation without touching a Phase 3 tree, recap, or session row', () => {
      expect(migrationSql).not.toMatch(
        /\b(UPDATE|DELETE FROM|TRUNCATE)\s+"?(monthly_trees|monthly_recaps|monthly_tree_traits|focus_sessions)"?/i,
      );
      // The species reference is added as a constraint only.
      expect(migrationSql).toMatch(/ALTER TABLE "monthly_trees" ADD CONSTRAINT/);
    });
  });
});
