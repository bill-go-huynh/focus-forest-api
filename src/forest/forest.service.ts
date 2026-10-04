import { Injectable, NotFoundException } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { FocusStatsService } from '../focus-stats/focus-stats.service.js';
import type { MonthlyTree } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { localMonthOf, monthIndex, type MonthRef } from '../sessions/attribution/calendar.js';
import { MonthClosureService } from '../trees/month-closure.service.js';
import { MonthlyTreesService } from '../trees/monthly-trees.service.js';
import { archivedTreeState, parseRecapContent, parseTreeArchive } from '../trees/tree-archive.js';
import type {
  ForestItemDto,
  ForestPageDto,
  PendingCeremonyDto,
  RecapDto,
  SeenStateDto,
  TreeDetailsDto,
} from './forest.dto.js';
import {
  decodeForestCursor,
  eligibleAreas,
  encodeForestCursor,
  forestPage,
  forestProgression,
  type ForestProgression,
} from './forest-timeline.js';

/**
 * The Personal Forest (docs/06_DOMAIN_MODEL.md → Forest), archived Tree Details, recaps, and the
 * month-end ceremony state. Every read closes ended months first, so it never shows a month that
 * should already be planted. Archived months come from their snapshots alone.
 */
@Injectable()
export class ForestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly closure: MonthClosureService,
    private readonly trees: MonthlyTreesService,
    private readonly stats: FocusStatsService,
    private readonly clock: Clock,
  ) {}

  /**
   * One page of the timeline, newest first. A fixed number of queries whatever the page size:
   * archived months come from one query of tree rows, resting months from their absence.
   */
  async page(userId: string, query: { cursor?: string; limit: number }): Promise<ForestPageDto> {
    const { start, end } = await this.range(userId);
    const after =
      query.cursor === undefined ? undefined : (decodeForestCursor(query.cursor) ?? undefined);
    const { months, next } = forestPage(start, end, { limit: query.limit, after });

    const rows = await this.treesBetween(userId, months.at(-1), months[0]);
    const byMonth = new Map(rows.map((row) => [monthIndex(row), row]));
    const items: ForestItemDto[] = [];
    for (const month of months) {
      const row = byMonth.get(monthIndex(month));
      if (!row) items.push({ kind: 'resting', ...month });
      else if (row.status === 'archived')
        items.push({ kind: 'archived', ...month, tree: this.archived(row) });
      else
        items.push({
          kind: 'growing',
          ...month,
          tree: await this.trees.state(this.prisma, userId, row),
        });
    }

    const treeCount = await this.prisma.monthlyTree.count({
      where: { userId, status: 'archived' },
    });
    return {
      items,
      nextCursor: next ? encodeForestCursor(next) : null,
      progression: await this.progression(userId, treeCount),
      summary: {
        treeCount,
        lifetimeFocusedMinutes: Math.floor(
          (await this.stats.lifetimeMilliseconds(userId)) / 60_000,
        ),
      },
    };
  }

  /**
   * Forest progression: the level from planted trees and the active thresholds; areas the
   * level reaches are stored once (concurrent reads insert each at most once), and stored areas
   * are never removed, so raising a threshold later never locks one again.
   */
  private async progression(userId: string, treeCount: number): Promise<ForestProgression> {
    const config = await this.config.active();
    const rules = {
      levelThresholds: config.get('forest.levelThresholds'),
      areaLevels: config.get('forest.areaLevels'),
    };
    const reached = eligibleAreas(forestProgression(treeCount, rules).level, rules);
    if (reached.length > 0) {
      await this.prisma.forestAreaUnlock.createMany({
        data: reached.map((areaId) => ({ userId, areaId, unlockedAt: this.clock.now() })),
        skipDuplicates: true,
      });
    }
    const stored = await this.prisma.forestAreaUnlock.findMany({
      where: { userId },
      select: { areaId: true },
    });
    return forestProgression(
      treeCount,
      rules,
      stored.map((row) => row.areaId),
    );
  }

  /** One month of the forest: an archived tree, a growing one, or a resting month. */
  async details(userId: string, month: MonthRef): Promise<TreeDetailsDto> {
    const { start, end } = await this.range(userId);
    if (monthIndex(month) < monthIndex(start) || monthIndex(month) > monthIndex(end)) {
      throw new NotFoundException('This month is not in your forest.');
    }
    const row = await this.prisma.monthlyTree.findUnique({ where: keyOf(userId, month) });
    if (!row) return { kind: 'resting', ...month };
    if (row.status === 'growing') {
      return { kind: 'growing', ...month, ...(await this.trees.growingView(userId, row)) };
    }
    const archive = parseTreeArchive(row.archive);
    const recap = await this.prisma.monthlyRecap.findUniqueOrThrow({ where: keyOf(userId, month) });
    return {
      kind: 'archived',
      ...month,
      archivedAt: (row.archivedAt ?? row.updatedAt).toISOString(),
      tree: archivedTreeState(row, archive),
      stats: archive.stats,
      // The notes as they were highlighted at archive, the same as the recap's.
      highlightedNotes: parseRecapContent(recap.content).highlightedNotes,
      badges: [],
      events: [],
    };
  }

  /** The stored recap of an archived month, as generated: it is never recomputed. */
  async recap(userId: string, month: MonthRef): Promise<RecapDto> {
    await this.closure.closeEndedMonths(userId);
    const recap = await this.prisma.monthlyRecap.findUnique({
      where: keyOf(userId, month),
      include: { tree: true },
    });
    if (!recap) throw recapNotFound();
    return {
      year: recap.year,
      month: recap.month,
      generatedAt: recap.createdAt.toISOString(),
      tree: archivedTreeState(recap.tree, parseTreeArchive(recap.tree.archive)),
      ...parseRecapContent(recap.content),
      ceremonySeenAt: recap.ceremonySeenAt?.toISOString() ?? null,
      recapSeenAt: recap.recapSeenAt?.toISOString() ?? null,
    };
  }

  /** Records the first time the ceremony or the recap was seen. Idempotent. */
  async markSeen(
    userId: string,
    month: MonthRef,
    what: 'ceremonySeenAt' | 'recapSeenAt',
  ): Promise<SeenStateDto> {
    await this.closure.closeEndedMonths(userId);
    await this.prisma.monthlyRecap.updateMany({
      where: { userId, ...month, [what]: null },
      data: { [what]: this.clock.now() },
    });
    const recap = await this.prisma.monthlyRecap.findUnique({ where: keyOf(userId, month) });
    if (!recap) throw recapNotFound();
    return {
      ceremonySeenAt: recap.ceremonySeenAt?.toISOString() ?? null,
      recapSeenAt: recap.recapSeenAt?.toISOString() ?? null,
    };
  }

  /**
   * The month-end ceremony to play: the latest archived month, until its ceremony is seen. Older
   * archived months, and resting months, are never queued; their recaps stay in the forest.
   * Close ended months before asking.
   */
  async pendingCeremony(userId: string): Promise<PendingCeremonyDto | null> {
    const latest = await this.prisma.monthlyRecap.findFirst({
      where: { userId },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      select: { year: true, month: true, ceremonySeenAt: true },
    });
    return latest && latest.ceremonySeenAt === null
      ? { year: latest.year, month: latest.month }
      : null;
  }

  /**
   * The forest's months, after closing ended ones: from the user's first month (the join month
   * in the current month's time zone, or an earlier month with stored activity) to the current
   * month, whose tree this creates if needed.
   */
  private async range(userId: string): Promise<{ start: MonthRef; end: MonthRef }> {
    await this.closure.closeEndedMonths(userId);
    const current = await this.trees.currentTree(userId);
    const end = { year: current.year, month: current.month };
    const [user, context, earliest] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } }),
      this.prisma.monthAttributionContext.findUniqueOrThrow({
        where: keyOf(userId, end),
        select: { timezone: true },
      }),
      this.prisma.monthAttributionContext.findFirst({
        where: { userId },
        orderBy: { startsAt: 'asc' },
        select: { year: true, month: true },
      }),
    ]);
    const joined = localMonthOf(user.createdAt, context.timezone);
    const candidates = [joined, ...(earliest ? [earliest] : [])].filter(
      (month) => monthIndex(month) <= monthIndex(end),
    );
    const start = candidates.reduce(
      (first, month) => (monthIndex(month) < monthIndex(first) ? month : first),
      end,
    );
    return { start, end };
  }

  private async treesBetween(
    userId: string,
    oldest: MonthRef | undefined,
    newest: MonthRef | undefined,
  ): Promise<MonthlyTree[]> {
    if (!oldest || !newest) return [];
    const yearRange =
      oldest.year === newest.year
        ? [{ year: oldest.year, month: { gte: oldest.month, lte: newest.month } }]
        : [
            { year: oldest.year, month: { gte: oldest.month } },
            { year: { gt: oldest.year, lt: newest.year } },
            { year: newest.year, month: { lte: newest.month } },
          ];
    return this.prisma.monthlyTree.findMany({ where: { userId, OR: yearRange } });
  }

  private archived(row: MonthlyTree) {
    return archivedTreeState(row, parseTreeArchive(row.archive));
  }
}

function keyOf(userId: string, month: MonthRef) {
  return { userId_year_month: { userId, year: month.year, month: month.month } };
}

function recapNotFound(): NotFoundException {
  return new NotFoundException('This month has no recap.');
}
