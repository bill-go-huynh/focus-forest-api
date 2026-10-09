import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { longestStreak, summarizeStreak } from '../consistency/streak.js';
import { StreakService } from '../consistency/streak.service.js';
import { UserTodayService } from '../consistency/user-today.service.js';
import { FocusStatsService } from '../focus-stats/focus-stats.service.js';
import {
  decodeForestCursor,
  encodeForestCursor,
  forestPage,
  forestProgression,
} from '../forest/forest-timeline.js';
import type { MonthlyTree } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { toBadgeDto, type EarnedBadgeDto } from '../progression/badge.dto.js';
import { ProgressionOwnershipService } from '../progression/progression-ownership.service.js';
import { RewardsService } from '../progression/rewards.service.js';
import { localMonthOf, monthIndex, type MonthRef } from '../sessions/attribution/calendar.js';
import type { ReactionSummaryResponse } from '../social/dto/social.dto.js';
import { ReactionsService } from '../social/reactions.service.js';
import {
  parseReactionTarget,
  REACTIONS,
  type ReactionKindId,
  type ReactionTarget,
} from '../social/reaction-target.js';
import { VisibilityService, type Viewing } from '../social/visibility.service.js';
import type { PrivacyCategory } from '../social/visibility.js';
import { MonthlyTreesService } from '../trees/monthly-trees.service.js';
import { archivedTreeState, parseRecapContent, parseTreeArchive } from '../trees/tree-archive.js';
import type { TreeStateDto } from '../trees/tree.contracts.js';
import type {
  VisitedForestItem,
  VisitedForestResponse,
  VisitedMonthResponse,
  VisitedProfileResponse,
} from './visits.dto.js';

const RECENT_BADGES = 3;

/**
 * A5.2: another user's profile, forest, and months, and reactions to them (spec §13.2–13.4).
 * Every read goes through the visibility gate. Visits only read: they never close the owner's
 * months, create a tree or a month, reconcile badges, or unlock forest areas. A month waiting for
 * closure shows as growing until the owner's own next request closes it.
 */
@Injectable()
export class VisitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: VisibilityService,
    private readonly reactions: ReactionsService,
    private readonly trees: MonthlyTreesService,
    private readonly stats: FocusStatsService,
    private readonly streak: StreakService,
    private readonly userToday: UserTodayService,
    private readonly ownership: ProgressionOwnershipService,
    private readonly rewards: RewardsService,
    private readonly config: ProductConfigService,
  ) {}

  async profile(viewerId: string, ownerId: string): Promise<VisitedProfileResponse> {
    const viewing = await this.viewing(viewerId, ownerId);
    const can = (category: PrivacyCategory) => this.visibility.can(viewing, category);
    const growing = can('currentTree')
      ? await this.prisma.monthlyTree.findFirst({
          where: { userId: ownerId, status: 'growing' },
          orderBy: [{ year: 'desc' }, { month: 'desc' }],
        })
      : null;
    return {
      user: this.visibility.card(viewing),
      currentTree: growing ? await this.treeState(ownerId, growing) : null,
      statistics: can('statistics') ? await this.statistics(ownerId) : null,
      badges: can('badges') ? await this.badges(ownerId) : null,
      forest: can('forest')
        ? {
            treeCount: await this.prisma.monthlyTree.count({
              where: { userId: ownerId, status: 'archived' },
            }),
          }
        : null,
      profileFrame: can('profile') ? (await this.rewards.equipment(ownerId)).profileFrame : null,
    };
  }

  async forest(
    viewerId: string,
    ownerId: string,
    query: { cursor?: string; limit: number },
  ): Promise<VisitedForestResponse> {
    const viewing = await this.viewing(viewerId, ownerId);
    this.require(viewing, 'forest');
    const range = await this.range(ownerId);
    const treeCount = await this.prisma.monthlyTree.count({
      where: { userId: ownerId, status: 'archived' },
    });
    const config = await this.config.active();
    const rules = {
      levelThresholds: config.get('forest.levelThresholds'),
      areaLevels: config.get('forest.areaLevels'),
    };
    const stored = await this.prisma.forestAreaUnlock.findMany({
      where: { userId: ownerId },
      select: { areaId: true },
    });
    const base = {
      summary: { treeCount },
      progression: forestProgression(
        treeCount,
        rules,
        stored.map((row) => row.areaId),
      ),
      equipment: (await this.rewards.equipment(ownerId)).forest,
    };
    if (!range) return { items: [], nextCursor: null, ...base };

    const after = query.cursor === undefined ? undefined : decodeForestCursor(query.cursor);
    if (after === null) throw new BadRequestException('cursor is not valid.');
    const { months, next } = forestPage(range.start, range.end, { limit: query.limit, after });
    const rows = await this.prisma.monthlyTree.findMany({
      where: {
        userId: ownerId,
        OR: months.map((month) => ({ year: month.year, month: month.month })),
      },
    });
    const byMonth = new Map(rows.map((row) => [monthIndex(row), row]));
    const showGrowing = this.visibility.can(viewing, 'currentTree');
    const items: VisitedForestItem[] = [];
    for (const month of months) {
      const row = byMonth.get(monthIndex(month));
      if (!row) items.push({ kind: 'resting', ...month });
      else if (row.status === 'archived') {
        items.push({
          kind: 'archived',
          ...month,
          tree: archivedTreeState(row, parseTreeArchive(row.archive)),
        });
      } else {
        items.push({
          kind: 'growing',
          ...month,
          tree: showGrowing ? await this.treeState(ownerId, row) : null,
        });
      }
    }
    return { items, nextCursor: next ? encodeForestCursor(next) : null, ...base };
  }

  async month(viewerId: string, ownerId: string, month: MonthRef): Promise<VisitedMonthResponse> {
    const viewing = await this.viewing(viewerId, ownerId);
    this.require(viewing, 'forest');
    const range = await this.range(ownerId);
    if (
      !range ||
      monthIndex(month) < monthIndex(range.start) ||
      monthIndex(month) > monthIndex(range.end)
    ) {
      throw new NotFoundException('This month is not in their forest.');
    }
    const row = await this.prisma.monthlyTree.findUnique({
      where: { userId_year_month: { userId: ownerId, year: month.year, month: month.month } },
    });
    if (!row) return { kind: 'resting', ...month };
    if (row.status === 'growing') {
      const tree = this.visibility.can(viewing, 'currentTree')
        ? await this.treeState(ownerId, row)
        : null;
      return { kind: 'growing', ...month, tree };
    }
    const archive = parseTreeArchive(row.archive);
    let badges: EarnedBadgeDto[] | null = null;
    if (this.visibility.can(viewing, 'badges')) {
      const recap = await this.prisma.monthlyRecap.findUniqueOrThrow({
        where: { userId_year_month: { userId: ownerId, year: month.year, month: month.month } },
      });
      const snapshot = parseRecapContent(recap.content).badges;
      const definitions = await this.ownership.badgesById(snapshot.map((badge) => badge.badgeId));
      badges = snapshot.flatMap((badge) => {
        const definition = definitions.get(badge.badgeId);
        return definition ? [{ ...definition, earnedAt: badge.earnedAt }] : [];
      });
    }
    // An allowlist: topic names stay personal, and a field added later is never shared by default.
    const {
      focusedMinutes,
      sessionCount,
      activeDays,
      dailyGoalsMet,
      weeklyGoalsMet,
      longestStreak,
    } = archive.stats;
    const stats = {
      focusedMinutes,
      sessionCount,
      activeDays,
      dailyGoalsMet,
      weeklyGoalsMet,
      longestStreak,
    };
    return {
      kind: 'archived',
      ...month,
      archivedAt: (row.archivedAt ?? row.updatedAt).toISOString(),
      tree: archivedTreeState(row, archive),
      badges,
      stats: this.visibility.can(viewing, 'statistics') ? stats : null,
    };
  }

  async react(
    viewerId: string,
    ownerId: string,
    reaction: string,
    target: string,
  ): Promise<ReactionSummaryResponse> {
    const kind = reactionKind(reaction);
    if (viewerId === ownerId) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'You cannot react to your own forest.',
        code: 'cannot_react_to_self',
      });
    }
    const resolved = await this.target(viewerId, ownerId, target);
    return this.reactions.add(viewerId, ownerId, resolved, kind);
  }

  async unreact(
    viewerId: string,
    ownerId: string,
    reaction: string,
    target: string,
  ): Promise<ReactionSummaryResponse> {
    const kind = reactionKind(reaction);
    const parsed = parseTarget(target);
    // Removing your own reaction needs only the owner to be visible: a hidden target can still be
    // cleaned up.
    await this.viewing(viewerId, ownerId);
    return this.reactions.remove(viewerId, ownerId, parsed, kind);
  }

  async reactionSummary(
    viewerId: string,
    ownerId: string,
    target: string,
  ): Promise<ReactionSummaryResponse> {
    return this.reactions.summary(viewerId, ownerId, await this.target(viewerId, ownerId, target));
  }

  /** The target, if the viewer may see it and it exists. */
  private async target(viewerId: string, ownerId: string, input: string): Promise<ReactionTarget> {
    const target = parseTarget(input);
    const viewing = await this.viewing(viewerId, ownerId);
    if (target.type === 'forest') {
      this.require(viewing, 'forest');
      return target;
    }
    if (target.type === 'badge') {
      this.require(viewing, 'badges');
      const owned = await this.prisma.userBadge.count({
        where: { userId: ownerId, badgeId: target.badgeId },
      });
      if (owned === 0) throw targetNotFound();
      return target;
    }
    const tree = await this.prisma.monthlyTree.findUnique({
      where: { userId_year_month: { userId: ownerId, year: target.year, month: target.month } },
      select: { status: true },
    });
    // A tree's privacy: the forest for planted trees, the current tree for growing ones.
    this.require(viewing, tree?.status === 'growing' ? 'currentTree' : 'forest');
    if (!tree) throw targetNotFound();
    return target;
  }

  private async viewing(viewerId: string, ownerId: string): Promise<Viewing> {
    const viewing = await this.visibility.view(viewerId, ownerId);
    if (!viewing) throw new NotFoundException('User not found.');
    return viewing;
  }

  private require(viewing: Viewing, category: PrivacyCategory): void {
    if (!this.visibility.can(viewing, category)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'They keep this private.',
        code: 'content_private',
      });
    }
  }

  /**
   * The owner's forest months without creating any: from their first month (the join month in
   * the latest month's time zone, or an earlier month) to the latest month the server knows.
   * Null before their first month exists.
   */
  private async range(ownerId: string): Promise<{ start: MonthRef; end: MonthRef } | null> {
    const [user, earliest, latest] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: ownerId }, select: { createdAt: true } }),
      this.prisma.monthAttributionContext.findFirst({
        where: { userId: ownerId },
        orderBy: { startsAt: 'asc' },
        select: { year: true, month: true },
      }),
      this.prisma.monthAttributionContext.findFirst({
        where: { userId: ownerId },
        orderBy: { startsAt: 'desc' },
        select: { year: true, month: true, timezone: true },
      }),
    ]);
    if (!earliest || !latest) return null;
    const end = { year: latest.year, month: latest.month };
    const joined = localMonthOf(user.createdAt, latest.timezone);
    const start = [joined, earliest]
      .filter((month) => monthIndex(month) <= monthIndex(end))
      .reduce((first, month) => (monthIndex(month) < monthIndex(first) ? month : first), end);
    return { start, end };
  }

  private treeState(ownerId: string, tree: MonthlyTree): Promise<TreeStateDto> {
    return this.trees.state(this.prisma, ownerId, tree);
  }

  private async statistics(ownerId: string): Promise<VisitedProfileResponse['statistics']> {
    const [lifetime, history, today] = await Promise.all([
      this.stats.lifetime(ownerId),
      this.streak.history(ownerId),
      this.userToday.today(ownerId).catch((error: unknown) => {
        if (error instanceof UnprocessableEntityException) return null;
        throw error;
      }),
    ]);
    return {
      focusedMinutes: Math.floor(lifetime.focusedMilliseconds / 60_000),
      sessionCount: lifetime.sessionCount,
      currentStreak: today === null ? null : summarizeStreak(history, today).current,
      longestStreak: longestStreak(history),
    };
  }

  /** Stored ownership only: a visit never grants anything. */
  private async badges(ownerId: string): Promise<NonNullable<VisitedProfileResponse['badges']>> {
    const [showcase, recent] = await Promise.all([
      this.prisma.badgeShowcase.findMany({
        where: { userId: ownerId },
        orderBy: { position: 'asc' },
        include: { ownership: { include: { badge: true } } },
      }),
      this.prisma.userBadge.findMany({
        where: { userId: ownerId },
        orderBy: [{ earnedAt: 'desc' }, { badgeId: 'asc' }],
        take: RECENT_BADGES,
        include: { badge: true },
      }),
    ]);
    const earned = (row: { badge: Parameters<typeof toBadgeDto>[0]; earnedAt: Date }) => ({
      ...toBadgeDto(row.badge),
      earnedAt: row.earnedAt.toISOString(),
    });
    return {
      showcase: showcase.map((row) => earned(row.ownership)),
      recent: recent.map(earned),
    };
  }
}

function reactionKind(input: string): ReactionKindId {
  if (!(REACTIONS as readonly string[]).includes(input)) {
    throw new BadRequestException(`reaction must be one of: ${REACTIONS.join(', ')}.`);
  }
  return input as ReactionKindId;
}

function parseTarget(input: string): ReactionTarget {
  const target = parseReactionTarget(input);
  if (!target) {
    throw new BadRequestException('target must be forest, tree:YYYY-MM, or badge:<badge id>.');
  }
  return target;
}

function targetNotFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    message: 'There is nothing to react to here.',
    code: 'reaction_target_not_found',
  });
}
