import { Injectable } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import type { FocusSession, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toBadgeDto, toCosmeticDto } from '../progression/badge.dto.js';
import {
  ContentNotAcquirableError,
  ProgressionOwnershipService,
} from '../progression/progression-ownership.service.js';
import { hemisphereFor, type Hemisphere } from './hemisphere.js';
import type { SeasonDto, SeasonalGrants } from './seasons.dto.js';

type Client = PrismaService | Prisma.TransactionClient;

const WITH_REWARDS = {
  rewards: {
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
    include: { badge: true, cosmetic: true },
  },
} satisfies Prisma.SeasonalThemeInclude;
type LoadedTheme = Prisma.SeasonalThemeGetPayload<{ include: typeof WITH_REWARDS }>;

/**
 * A5.9 Seasonal content (spec §17, docs/03 §10, docs/06 SeasonalTheme / LimitedCollection).
 * Themes are content for a hemisphere (or both) and a window; they change the environment and
 * atmosphere, never the tree's earned structure, so no tree answer carries them. A theme's
 * limited collection is earned with normal focus (active days in its window) and owned forever.
 */
@Injectable()
export class SeasonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: ProgressionOwnershipService,
    private readonly clock: Clock,
  ) {}

  async season(userId: string): Promise<SeasonDto> {
    const now = this.clock.now();
    const { hemisphere, source } = await this.hemisphere(this.prisma, userId);
    const theme = await this.prisma.seasonalTheme.findFirst({
      where: { ...applying(hemisphere), startsAt: { lte: now }, endsAt: { gt: now } },
      include: WITH_REWARDS,
      orderBy: [{ sortOrder: 'asc' }, { startsAt: 'asc' }, { id: 'asc' }],
    });
    if (!theme) return { hemisphere, hemisphereSource: source, theme: null, rewards: [] };

    const activeDays = await this.activeDays(this.prisma, userId, theme);
    await this.reconcile(this.prisma, userId, theme, activeDays);
    const [badges, cosmetics] = await Promise.all([
      this.prisma.userBadge.findMany({
        where: { userId, badgeId: { in: theme.rewards.flatMap((r) => r.badgeId ?? []) } },
        select: { badgeId: true },
      }),
      this.prisma.userCosmetic.findMany({
        where: { userId, cosmeticId: { in: theme.rewards.flatMap((r) => r.cosmeticId ?? []) } },
        select: { cosmeticId: true },
      }),
    ]);
    const owned = new Set([
      ...badges.map((row) => `badge:${row.badgeId}`),
      ...cosmetics.map((row) => `cosmetic:${row.cosmeticId}`),
    ]);
    return {
      hemisphere,
      hemisphereSource: source,
      theme: {
        id: theme.id,
        name: theme.name,
        description: theme.description,
        environmentId: theme.environmentId,
        startsAt: theme.startsAt.toISOString(),
        endsAt: theme.endsAt.toISOString(),
      },
      rewards: theme.rewards.map((reward) =>
        reward.badge
          ? {
              id: reward.id,
              kind: 'badge' as const,
              item: toBadgeDto(reward.badge),
              requiredActiveDays: reward.requiredActiveDays,
              activeDays,
              owned: owned.has(`badge:${reward.badge.id}`),
            }
          : {
              id: reward.id,
              kind: 'cosmetic' as const,
              item: toCosmeticDto(reward.cosmetic!),
              requiredActiveDays: reward.requiredActiveDays,
              activeDays,
              owned: owned.has(`cosmetic:${reward.cosmetic!.id}`),
            },
      ),
    };
  }

  /** Sets the user's hemisphere (null: derive it from the time zone again). */
  async setHemisphere(userId: string, hemisphere: Hemisphere | null): Promise<SeasonDto> {
    await this.prisma.user.update({ where: { id: userId }, data: { hemisphere } });
    return this.season(userId);
  }

  /**
   * In the session submission transaction: the seasonal rewards the user now qualifies for, in
   * every active theme of their hemisphere whose window holds the session's start. Reported
   * through the session's progression result.
   */
  async evaluateSession(
    tx: Prisma.TransactionClient,
    userId: string,
    session: FocusSession,
  ): Promise<SeasonalGrants> {
    const { hemisphere } = await this.hemisphere(tx, userId);
    const themes = await tx.seasonalTheme.findMany({
      where: {
        ...applying(hemisphere),
        startsAt: { lte: session.startedAt },
        endsAt: { gt: session.startedAt },
      },
      include: WITH_REWARDS,
      orderBy: [{ sortOrder: 'asc' }, { startsAt: 'asc' }, { id: 'asc' }],
    });
    const grants: SeasonalGrants = { badgeIds: [], cosmeticIds: [] };
    for (const theme of themes) {
      const activeDays = await this.activeDays(tx, userId, theme);
      const created = await this.reconcile(tx, userId, theme, activeDays);
      grants.badgeIds.push(...created.badgeIds);
      grants.cosmeticIds.push(...created.cosmeticIds);
    }
    return grants;
  }

  /** Grants the theme's rewards reached, while acquirable; returns the ones this call created. */
  private async reconcile(
    client: Client,
    userId: string,
    theme: LoadedTheme,
    activeDays: number,
  ): Promise<SeasonalGrants> {
    const now = this.clock.now();
    const created: SeasonalGrants = { badgeIds: [], cosmeticIds: [] };
    for (const reward of theme.rewards.filter((r) => activeDays >= r.requiredActiveDays)) {
      try {
        if (reward.badgeId) {
          const { granted } = await this.ownership.grantBadge(userId, reward.badgeId, now, client);
          if (granted) created.badgeIds.push(reward.badgeId);
        } else if (reward.cosmeticId) {
          const { granted } = await this.ownership.grantCosmetic(
            userId,
            reward.cosmeticId,
            now,
            client,
          );
          if (granted) created.cosmeticIds.push(reward.cosmeticId);
        }
      } catch (error) {
        // Its content window has ended: no longer earnable, nothing lost.
        if (!(error instanceof ContentNotAcquirableError)) throw error;
      }
    }
    return created;
  }

  /** Local dates with a counted session that started in the theme's window. */
  private async activeDays(
    client: Client,
    userId: string,
    theme: { startsAt: Date; endsAt: Date },
  ): Promise<number> {
    const [row] = await client.$queryRaw<{ days: bigint }[]>`
      SELECT COUNT(DISTINCT local_date) AS days FROM focus_sessions
      WHERE user_id = ${userId}::uuid AND status <> 'discarded'
        AND started_at >= ${theme.startsAt} AND started_at < ${theme.endsAt}`;
    return Number(row?.days ?? 0);
  }

  private async hemisphere(client: Client, userId: string) {
    const user = await client.user.findUniqueOrThrow({
      where: { id: userId },
      select: { hemisphere: true, timezone: true },
    });
    return hemisphereFor(user.hemisphere, user.timezone);
  }
}

/** Active themes for this hemisphere, or for both. */
function applying(hemisphere: Hemisphere): Prisma.SeasonalThemeWhereInput {
  return { status: 'active', OR: [{ hemisphere }, { hemisphere: null }] };
}
