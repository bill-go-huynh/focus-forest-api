import { Injectable } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { firstDateOfMonth, lastDateOfMonth } from '../common/local-date.js';
import { lockUser } from '../consistency/db.js';
import { GoalsService } from '../consistency/goals.service.js';
import type { ActivityHistory } from '../consistency/streak.js';
import { StreakService } from '../consistency/streak.service.js';
import type { DayFocus } from '../focus-stats/focus-stats.js';
import { FocusStatsService } from '../focus-stats/focus-stats.service.js';
import type { MonthAttributionContext, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { ProgressionOwnershipService } from '../progression/progression-ownership.service.js';
import {
  longestStreakWithin,
  mostProductiveDay,
  mostProductiveWeek,
} from '../records/month-highlights.js';
import { newPersonalRecords } from '../records/personal-records.js';
import type { MonthRef } from '../sessions/attribution/calendar.js';
import { MonthlyTreesService } from './monthly-trees.service.js';
import {
  parseRecapContent,
  parseTreeArchive,
  type ArchivedMonthStatsDto,
  type RecapContent,
} from './tree-archive.js';

type Client = Prisma.TransactionClient;

const MINUTE_MS = 60_000;
const CLOSE_TIMEOUT_MS = 20_000;

/**
 * Closes ended months (docs/06_DOMAIN_MODEL.md → MonthlyTree): lazily, when a request needs
 * current month state, never on a schedule. A month is due once its attribution context has
 * ended (in the month's own time zone, frozen in the context) plus `session.monthGraceMinutes`
 * of the active configuration. Closing a month with counted focus reconciles its tree once,
 * freezes it with the month's stats, and stores its recap; a month without counted focus rests
 * (a Seed created by a view is removed). Each month closes in one transaction under the user's
 * row lock, and `closedAt` makes it happen exactly once.
 */
@Injectable()
export class MonthClosureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly trees: MonthlyTreesService,
    private readonly stats: FocusStatsService,
    private readonly goals: GoalsService,
    private readonly streak: StreakService,
    private readonly ownership: ProgressionOwnershipService,
    private readonly clock: Clock,
  ) {}

  /** Closes every due month of the user, oldest first, one transaction each. */
  async closeEndedMonths(userId: string): Promise<void> {
    for (const due of await this.dueContexts(this.prisma, userId)) {
      await this.prisma.$transaction(
        async (tx) => {
          await lockUser(tx, userId);
          const context = await tx.monthAttributionContext.findUnique({
            where: keyOf(userId, due),
          });
          // Another request may have closed it while this one waited for the lock.
          if (context && context.closedAt === null) await this.close(tx, userId, context);
        },
        // Closing reads the user's whole history once; rare, so it may take longer than a read.
        { timeout: CLOSE_TIMEOUT_MS },
      );
    }
  }

  /** The same inside the caller's transaction, which holds the user's row lock. */
  async closeEndedMonthsIn(tx: Client, userId: string): Promise<void> {
    for (const context of await this.dueContexts(tx, userId)) await this.close(tx, userId, context);
  }

  /** Whether the month is closed: its sessions no longer grow a tree. */
  async isClosed(client: Client, userId: string, month: MonthRef): Promise<boolean> {
    const context = await client.monthAttributionContext.findUnique({
      where: keyOf(userId, month),
      select: { closedAt: true },
    });
    return context?.closedAt != null;
  }

  private async dueContexts(client: Client, userId: string): Promise<MonthAttributionContext[]> {
    const graceMinutes = (await this.config.active()).get('session.monthGraceMinutes');
    const endedBy = new Date(this.clock.now().getTime() - graceMinutes * MINUTE_MS);
    return client.monthAttributionContext.findMany({
      where: { userId, closedAt: null, endsAt: { lte: endedBy } },
      orderBy: { startsAt: 'asc' },
    });
  }

  private async close(tx: Client, userId: string, context: MonthAttributionContext) {
    const month = { year: context.year, month: context.month };
    const now = this.clock.now();
    const days = await this.stats.monthDays(userId, month, tx);

    if (days.length === 0) {
      // A quiet month has no tree (the forest shows a resting marker), not even a viewed Seed.
      await tx.monthlyTree.deleteMany({ where: { userId, ...month } });
    } else {
      const { tree: found } = await this.trees.ensureTree(tx, userId, month);
      // Stored truth may have changed since the last session or view: bring it up to date once.
      const tree = await this.trees.reconcile(tx, userId, found);
      const earned = await this.trees.earnedView(tx, userId, tree);
      const history = await this.streak.history(userId, tx);
      const stats = await this.monthStats(tx, userId, month, days, history);
      const archive = parseTreeArchive({
        timezone: context.timezone,
        progress: earned.progress,
        traits: earned.traits,
        stats,
      });
      await tx.monthlyTree.update({
        where: keyOf(userId, month),
        data: {
          status: 'archived',
          archivedAt: now,
          archive: archive as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.monthlyRecap.create({
        data: {
          userId,
          ...month,
          content: (await this.recap(
            tx,
            userId,
            context,
            days,
            stats,
            history,
          )) as unknown as Prisma.InputJsonValue,
          createdAt: now,
        },
      });
    }
    await tx.monthAttributionContext.update({
      where: keyOf(userId, month),
      data: { closedAt: now },
    });
  }

  private async monthStats(
    tx: Client,
    userId: string,
    month: MonthRef,
    days: DayFocus[],
    history: ActivityHistory,
  ): Promise<ArchivedMonthStatsDto> {
    const topics = await this.stats.monthTopics(userId, month, tx);
    const goals = await this.goals.monthCompletions(userId, month, tx);
    const top = topics[0]
      ? await tx.topic.findUnique({
          where: { userId_id: { userId, id: topics[0].topicId } },
          select: { id: true, name: true, icon: true, color: true },
        })
      : null;
    return {
      focusedMinutes: Math.floor(
        days.reduce((sum, day) => sum + day.focusedMilliseconds, 0) / MINUTE_MS,
      ),
      sessionCount: days.reduce((sum, day) => sum + day.sessionCount, 0),
      activeDays: days.length,
      dailyGoalsMet: goals.daily,
      weeklyGoalsMet: goals.weekly,
      longestStreak: longestStreakWithin(history, firstDateOfMonth(month), lastDateOfMonth(month)),
      topTopic: top,
    };
  }

  private async recap(
    tx: Client,
    userId: string,
    context: MonthAttributionContext,
    days: DayFocus[],
    stats: ArchivedMonthStatsDto,
    history: ActivityHistory,
  ): Promise<RecapContent> {
    const month = { year: context.year, month: context.month };
    const first = firstDateOfMonth(month);
    const last = lastDateOfMonth(month);
    const allDays = await this.stats.allDays(userId, tx);
    const records = newPersonalRecords(
      {
        days: allDays,
        longestSessions: await this.stats.longestSessionsByDay(userId, tx),
        activity: history,
        goalMetDates: await this.goals.metDates(userId, allDays[0]?.date ?? first, last, tx),
      },
      { from: first, to: last },
    );
    // Only notes the user highlighted, copied as they read now: the recap never follows later edits.
    const highlighted = await tx.focusSession.findMany({
      where: { userId, ...month, noteHighlighted: true, note: { not: null } },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, note: true },
    });
    return parseRecapContent({
      stats,
      mostProductiveDay: mostProductiveDay(days, month),
      mostProductiveWeek: mostProductiveWeek(days, month),
      newRecords: records,
      highlightedNotes: highlighted.flatMap(({ id, note }) =>
        note ? [{ sessionId: id, note }] : [],
      ),
      // Earned in the month's own attribution window (its frozen time zone), never the UTC
      // month; badges granted later, even dated in this window, never reach the snapshot.
      badges: await this.ownership.badgesEarnedIn(userId, context.startsAt, context.endsAt, tx),
      events: [],
    });
  }
}

function keyOf(userId: string, month: MonthRef) {
  return { userId_year_month: { userId, year: month.year, month: month.month } };
}
