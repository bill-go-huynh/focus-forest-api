import { Injectable } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toBadgeDto, type BadgeDto } from './badge.dto.js';
import { acquirableAt, type Acquisition, type AcquisitionCheck } from './progression-rules.js';

type Client = PrismaService | Prisma.TransactionClient;

export type ContentKind = 'badge' | 'species' | 'cosmetic';

/** The content does not exist (an unknown identifier). */
export class ContentNotFoundError extends Error {
  constructor(
    readonly kind: ContentKind,
    readonly id: string,
  ) {
    super(`No ${kind} "${id}".`);
  }
}

/** The content exists but cannot be acquired now (planned, retired, outside its window, …). */
export class ContentNotAcquirableError extends Error {
  constructor(
    readonly kind: ContentKind,
    readonly id: string,
    readonly reason: Extract<AcquisitionCheck, { acquirable: false }>['reason'],
  ) {
    super(`The ${kind} "${id}" cannot be acquired now (${reason}).`);
  }
}

export interface Grant {
  /** True only for the call that created the ownership. */
  granted: boolean;
  /** When the user first owned it: this grant's time, or the earlier one. */
  at: Date;
}

/** What one content kind needs for a grant: its definition, and its ownership row. */
interface Store {
  definition(client: Client, id: string): Promise<Acquisition | null>;
  owned(client: Client, userId: string, id: string): Promise<Date | null>;
  insert(client: Client, userId: string, id: string, at: Date): Promise<number>;
}

const STORES: Record<ContentKind, Store> = {
  badge: {
    definition: (c, id) => c.badgeDefinition.findUnique({ where: { id } }),
    owned: async (c, userId, badgeId) =>
      (await c.userBadge.findUnique({ where: { userId_badgeId: { userId, badgeId } } }))
        ?.earnedAt ?? null,
    insert: async (c, userId, badgeId, earnedAt) =>
      (
        await c.userBadge.createMany({
          data: [{ userId, badgeId, earnedAt }],
          skipDuplicates: true,
        })
      ).count,
  },
  species: {
    definition: (c, id) => c.treeSpecies.findUnique({ where: { id } }),
    owned: async (c, userId, speciesId) =>
      (await c.userSpecies.findUnique({ where: { userId_speciesId: { userId, speciesId } } }))
        ?.unlockedAt ?? null,
    insert: async (c, userId, speciesId, unlockedAt) =>
      (
        await c.userSpecies.createMany({
          data: [{ userId, speciesId, unlockedAt }],
          skipDuplicates: true,
        })
      ).count,
  },
  cosmetic: {
    definition: (c, id) => c.cosmeticDefinition.findUnique({ where: { id } }),
    owned: async (c, userId, cosmeticId) =>
      (await c.userCosmetic.findUnique({ where: { userId_cosmeticId: { userId, cosmeticId } } }))
        ?.unlockedAt ?? null,
    insert: async (c, userId, cosmeticId, unlockedAt) =>
      (
        await c.userCosmetic.createMany({
          data: [{ userId, cosmeticId, unlockedAt }],
          skipDuplicates: true,
        })
      ).count,
  },
};

/**
 * Permanent progression ownership (A4.1): the one way badges, species, and cosmetics are
 * granted, for the evaluators and sources that arrive later (A4.2 achievements, Phase 14 events,
 * Phase 17 seasons). A grant is idempotent and safe under concurrency without a lock: the
 * ownership's primary key decides, and the insert skips a duplicate. Availability decides only
 * whether something can be acquired; nothing here removes ownership, and there is no revoke.
 * Grants never touch focus, growth, goals, streaks, or recovery.
 */
@Injectable()
export class ProgressionOwnershipService {
  constructor(private readonly prisma: PrismaService) {}

  grantBadge(userId: string, badgeId: string, at: Date, client: Client = this.prisma) {
    return this.grant('badge', userId, badgeId, at, client).then(({ granted, at: earnedAt }) => ({
      granted,
      earnedAt,
    }));
  }

  grantSpecies(userId: string, speciesId: string, at: Date, client: Client = this.prisma) {
    return this.grant('species', userId, speciesId, at, client).then(
      ({ granted, at: unlockedAt }) => ({ granted, unlockedAt }),
    );
  }

  grantCosmetic(userId: string, cosmeticId: string, at: Date, client: Client = this.prisma) {
    return this.grant('cosmetic', userId, cosmeticId, at, client).then(
      ({ granted, at: unlockedAt }) => ({ granted, unlockedAt }),
    );
  }

  /**
   * Grants several badges in one statement (the achievement evaluator, A4.2), each with its own
   * earned time; whether each can be acquired is decided at `at`. Returns the grants this call
   * created, in the given order: a badge already owned, or granted concurrently, is skipped.
   */
  async grantBadges(
    userId: string,
    grants: readonly { badgeId: string; earnedAt: Date }[],
    at: Date,
    client: Client = this.prisma,
  ): Promise<{ badgeId: string; earnedAt: Date }[]> {
    if (grants.length === 0) return [];
    const definitions = new Map(
      (
        await client.badgeDefinition.findMany({
          where: { id: { in: grants.map((grant) => grant.badgeId) } },
        })
      ).map((definition) => [definition.id, definition]),
    );
    for (const { badgeId } of grants) {
      const definition = definitions.get(badgeId);
      if (!definition) throw new ContentNotFoundError('badge', badgeId);
      const check = acquirableAt(definition, at);
      if (!check.acquirable) throw new ContentNotAcquirableError('badge', badgeId, check.reason);
    }
    const created = await client.userBadge.createManyAndReturn({
      data: grants.map(({ badgeId, earnedAt }) => ({ userId, badgeId, earnedAt })),
      skipDuplicates: true,
      select: { badgeId: true, earnedAt: true },
    });
    const createdIds = new Set(created.map((row) => row.badgeId));
    return grants
      .filter((grant) => createdIds.has(grant.badgeId))
      .map(({ badgeId, earnedAt }) => ({ badgeId, earnedAt }));
  }

  /**
   * The badges the user earned in [from, to), by stable id, in earned order: what a month's
   * recap snapshots at archive, with the month's own attribution window.
   */
  async badgesEarnedIn(
    userId: string,
    from: Date,
    to: Date,
    client: Client = this.prisma,
  ): Promise<{ badgeId: string; earnedAt: string }[]> {
    const rows = await client.userBadge.findMany({
      where: { userId, earnedAt: { gte: from, lt: to } },
      orderBy: [{ earnedAt: 'asc' }, { badgeId: 'asc' }],
    });
    return rows.map((row) => ({ badgeId: row.badgeId, earnedAt: row.earnedAt.toISOString() }));
  }

  /** Badge definitions as the app shows them, by id. */
  async badgesById(ids: readonly string[], client: Client = this.prisma) {
    if (ids.length === 0) return new Map<string, BadgeDto>();
    const rows = await client.badgeDefinition.findMany({ where: { id: { in: [...ids] } } });
    return new Map(rows.map((row) => [row.id, toBadgeDto(row)]));
  }

  /** Badge ids the user owns, in the order they were earned. */
  async ownedBadgeIds(userId: string, client: Client = this.prisma): Promise<string[]> {
    const rows = await client.userBadge.findMany({
      where: { userId },
      orderBy: [{ earnedAt: 'asc' }, { badgeId: 'asc' }],
    });
    return rows.map((row) => row.badgeId);
  }

  /** Species the user owns: every system species, and those unlocked. Sorted by id. */
  async ownedSpeciesIds(userId: string, client: Client = this.prisma): Promise<string[]> {
    const [system, unlocked] = await Promise.all([
      client.treeSpecies.findMany({ where: { source: 'system' }, select: { id: true } }),
      client.userSpecies.findMany({ where: { userId }, select: { speciesId: true } }),
    ]);
    return [...new Set([...system.map((s) => s.id), ...unlocked.map((u) => u.speciesId)])].sort();
  }

  async ownsSpecies(userId: string, speciesId: string, client: Client = this.prisma) {
    const species = await client.treeSpecies.findUnique({ where: { id: speciesId } });
    if (!species) return false;
    if (species.source === 'system') return true;
    return (await STORES.species.owned(client, userId, speciesId)) !== null;
  }

  private async grant(
    kind: ContentKind,
    userId: string,
    id: string,
    at: Date,
    client: Client,
  ): Promise<Grant> {
    const store = STORES[kind];
    const definition = await store.definition(client, id);
    if (!definition) throw new ContentNotFoundError(kind, id);
    // Already owned: kept as it was, whatever the content's availability is now.
    const earlier = await store.owned(client, userId, id);
    if (earlier) return { granted: false, at: earlier };
    const check = acquirableAt(definition, at);
    if (!check.acquirable) throw new ContentNotAcquirableError(kind, id, check.reason);
    if ((await store.insert(client, userId, id, at)) === 1) return { granted: true, at };
    // Another grant won the race.
    return { granted: false, at: (await store.owned(client, userId, id)) ?? at };
  }
}
