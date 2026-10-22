import { Injectable } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { earnableAchievements } from './achievement-evaluation.js';
import { AchievementsService } from './achievements.service.js';
import {
  availabilityOf,
  byCatalogOrder,
  isVisible,
  summarize,
  unlockOf,
  type CollectionAvailability,
  type UnlockHint,
} from './collection.js';
import type {
  BadgeCategory,
  ContentRarity,
  ContentSource,
  CosmeticType,
} from './progression-rules.js';

/** The signature species a month's tree starts with until another is chosen. */
const DEFAULT_SPECIES = 'signature';

interface CollectionItemBase {
  id: string;
  name: string;
  description: string;
  rarity: ContentRarity;
  /** Bundled artwork in the app; species are drawn by their id (null). */
  artworkId: string | null;
  owned: boolean;
  /** When an ownership row was stored; null for owned-by-everyone content and locked items. */
  ownedAt: string | null;
  source: ContentSource;
  availability: CollectionAvailability;
  /** How a locked item is obtained; null when owned or owned by everyone. */
  unlock: UnlockHint | null;
}

export type CollectionItem =
  | (CollectionItemBase & {
      kind: 'species';
      baseSpeciesId: string | null;
      /** The species of the current month's tree (or the one it will start with). */
      selected: boolean;
    })
  | (CollectionItemBase & {
      kind: 'badge';
      category: BadgeCategory;
      showcasePosition: number | null;
    })
  | (CollectionItemBase & { kind: 'cosmetic'; type: CosmeticType; equipped: boolean });

export interface CollectionSection {
  kind: 'species' | 'badges' | 'cosmetics';
  /** Visible items only: a count, never a percentage. */
  owned: number;
  total: number;
  items: CollectionItem[];
}

export interface CollectionResponse {
  /** In a fixed product order; later phases add sections without redesign. */
  sections: CollectionSection[];
}

/**
 * GET /me/collection (A4.4): one reconciliation (so a reward the user already qualifies for is
 * owned), then a fixed set of batched reads, whatever the catalog size. Reads only: it never
 * creates a tree, a month context, or any Core state, and reports no unlock as new.
 */
@Injectable()
export class CollectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly achievements: AchievementsService,
    private readonly clock: Clock,
  ) {}

  async collection(userId: string): Promise<CollectionResponse> {
    await this.achievements.reconcile(userId);
    const now = this.clock.now();
    const [
      achievements,
      badges,
      userBadges,
      species,
      userSpecies,
      cosmetics,
      userCosmetics,
      equipment,
      currentTree,
      values,
    ] = await Promise.all([
      this.prisma.achievementDefinition.findMany({ include: { badge: true } }),
      this.prisma.badgeDefinition.findMany(),
      this.prisma.userBadge.findMany({ where: { userId }, include: { showcase: true } }),
      this.prisma.treeSpecies.findMany(),
      this.prisma.userSpecies.findMany({ where: { userId } }),
      this.prisma.cosmeticDefinition.findMany(),
      this.prisma.userCosmetic.findMany({ where: { userId } }),
      this.prisma.userEquipment.findMany({ where: { userId }, select: { cosmeticId: true } }),
      // The current month's growing tree, if it exists: read, never created.
      this.prisma.monthlyTree.findFirst({
        where: {
          userId,
          status: 'growing',
          monthContext: { startsAt: { lte: now }, endsAt: { gt: now } },
        },
        select: { species: true },
      }),
      this.achievements.values(userId),
    ]);

    const achievementById = new Map(achievements.map((a) => [a.id, a]));
    const achievementByBadge = new Map(achievements.map((a) => [a.badgeId, a]));
    const earnable = new Set(earnableAchievements(achievements, now).map((a) => a.id));
    const hintFor = (source: ContentSource, achievementId: string | null) => {
      const achievement = achievementId ? achievementById.get(achievementId) : undefined;
      return unlockOf(
        { source },
        achievement ? { achievement, value: values[achievement.criterion] } : null,
      );
    };
    // Season content is earned by taking part, never shown before it is owned (no FOMO).
    const reachable = (source: ContentSource, achievementId: string | null) =>
      source === 'system' ||
      (source === 'achievement' && achievementId !== null && earnable.has(achievementId));

    const ownedBadges = new Map(userBadges.map((row) => [row.badgeId, row]));
    const badgeItems: CollectionItem[] = badges
      .filter((badge) =>
        isVisible(
          badge,
          {
            owned: ownedBadges.has(badge.id),
            reachable: reachable(badge.source, achievementByBadge.get(badge.id)?.id ?? null),
          },
          now,
        ),
      )
      .sort(byCatalogOrder)
      .map((badge) => {
        const row = ownedBadges.get(badge.id);
        return {
          kind: 'badge',
          id: badge.id,
          name: badge.name,
          description: badge.description,
          rarity: badge.rarity,
          artworkId: badge.artworkId,
          owned: row !== undefined,
          ownedAt: row?.earnedAt.toISOString() ?? null,
          source: badge.source,
          availability: availabilityOf(badge, now),
          unlock: row ? null : hintFor(badge.source, achievementByBadge.get(badge.id)?.id ?? null),
          category: badge.category,
          showcasePosition: row?.showcase?.position ?? null,
        };
      });

    const ownedSpecies = new Map(userSpecies.map((row) => [row.speciesId, row.unlockedAt]));
    const currentSpecies = currentTree?.species ?? DEFAULT_SPECIES;
    const speciesItems: CollectionItem[] = species
      .filter((s) =>
        isVisible(
          s,
          {
            owned: s.source === 'system' || ownedSpecies.has(s.id),
            reachable: reachable(s.source, s.achievementId),
          },
          now,
        ),
      )
      .sort(byCatalogOrder)
      .map((s) => {
        const owned = s.source === 'system' || ownedSpecies.has(s.id);
        return {
          kind: 'species',
          id: s.id,
          name: s.name,
          description: s.description,
          rarity: s.rarity,
          artworkId: null,
          owned,
          ownedAt: ownedSpecies.get(s.id)?.toISOString() ?? null,
          source: s.source,
          availability: availabilityOf(s, now),
          unlock: owned ? null : hintFor(s.source, s.achievementId),
          baseSpeciesId: s.baseSpeciesId,
          selected: s.id === currentSpecies,
        };
      });

    const ownedCosmetics = new Map(userCosmetics.map((row) => [row.cosmeticId, row.unlockedAt]));
    const equipped = new Set(equipment.map((row) => row.cosmeticId));
    const cosmeticItems: CollectionItem[] = cosmetics
      .filter((c) =>
        isVisible(
          c,
          {
            owned: c.source === 'system' || ownedCosmetics.has(c.id),
            reachable: reachable(c.source, c.achievementId),
          },
          now,
        ),
      )
      .sort(byCatalogOrder)
      .map((c) => {
        const owned = c.source === 'system' || ownedCosmetics.has(c.id);
        return {
          kind: 'cosmetic',
          id: c.id,
          name: c.name,
          description: c.description,
          rarity: c.rarity,
          artworkId: c.artworkId,
          owned,
          ownedAt: ownedCosmetics.get(c.id)?.toISOString() ?? null,
          source: c.source,
          availability: availabilityOf(c, now),
          unlock: owned ? null : hintFor(c.source, c.achievementId),
          type: c.type,
          equipped: equipped.has(c.id),
        };
      });

    const section = (kind: CollectionSection['kind'], items: CollectionItem[]) => ({
      kind,
      ...summarize(items),
      items,
    });
    return {
      sections: [
        section('species', speciesItems),
        section('badges', badgeItems),
        section('cosmetics', cosmeticItems),
      ],
    };
  }
}
