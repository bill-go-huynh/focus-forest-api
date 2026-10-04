import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import {
  addDays,
  compareLocalDates,
  daysBetween,
  firstDateOfMonth,
  isLocalDate,
  lastDateOfMonth,
  weekStartOf,
  type LocalDate,
} from '../common/local-date.js';
import { goalMetDates, weeklyGoalForWeek, weeklyProgress } from '../consistency/goals.js';
import { GoalsService } from '../consistency/goals.service.js';
import { RestDaysService } from '../consistency/rest-days.service.js';
import { summarizeStreak, type ActivityHistory } from '../consistency/streak.js';
import { StreakService } from '../consistency/streak.service.js';
import { UserTodayService } from '../consistency/user-today.service.js';
import type { DayFocus } from '../focus-stats/focus-stats.js';
import { FocusStatsService, type SessionScope } from '../focus-stats/focus-stats.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  longestStreakWithin,
  mostProductiveDay,
  mostProductiveWeek,
} from '../records/month-highlights.js';
import {
  newPersonalRecords,
  personalRecords,
  type RecordsInput,
} from '../records/personal-records.js';
import { monthIndex, type MonthRef } from '../sessions/attribution/calendar.js';
import { MonthClosureService } from '../trees/month-closure.service.js';
import { parseTreeArchive } from '../trees/tree-archive.js';
import {
  averagePerActiveDay,
  dailyGoalRate,
  dayCells,
  topicShares,
  weeklyGoalRate,
} from './insights.js';
import {
  HEATMAP_DEFAULT_DAYS,
  HEATMAP_MAX_DAYS,
  type FocusSummaryDto,
  type HeatmapDto,
  type LifetimeStatsDto,
  type LongestSessionDto,
  type MonthInsightsDto,
  type PeriodStreakDto,
  type RecordsDto,
  type TopicInsightDto,
  type WeekInsightsDto,
} from './insights.dto.js';

/**
 * Insights, records, and lifetime stats (A3.5). Every number is aggregated from stored focus
 * sessions (counted ones only) with a fixed number of queries, whatever the history's length;
 * archived snapshots are only read, never changed. Late sessions of a closed month count here.
 */
@Injectable()
export class InsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: FocusStatsService,
    private readonly goals: GoalsService,
    private readonly restDays: RestDaysService,
    private readonly streak: StreakService,
    private readonly userToday: UserTodayService,
    private readonly closure: MonthClosureService,
  ) {}

  async week(userId: string, weekStart?: string): Promise<WeekInsightsDto> {
    const today = await this.userToday.today(userId);
    const from = weekStart ?? weekStartOf(today);
    if (!isLocalDate(from) || weekStartOf(from) !== from) {
      throw badRequest('weekStart must be a Monday (YYYY-MM-DD): weeks run Monday to Sunday.');
    }
    const to = addDays(from, 6);
    const scope = { from, to };
    const [days, context] = [await this.stats.scopeDays(userId, scope), await this.context(userId)];
    const cells = dayCells({
      from,
      to,
      today,
      days,
      restDates: context.restDates,
      dailyVersions: context.versions.daily,
    });
    const goal = weeklyGoalForWeek(context.versions.weekly, from);
    return {
      period: { kind: 'week', from, to, current: from === weekStartOf(today) },
      summary: summarize(days),
      days: cells,
      topics: await this.topics(userId, scope),
      longestSession: await this.longest(userId, scope),
      goals: {
        daily: dailyGoalRate(cells),
        weekly: goal ? weeklyProgress(from, days, goal) : null,
      },
      restDays: cells.filter((cell) => cell.rest).length,
      streak: periodStreak(context.history, today, from, to),
      newRecords: newPersonalRecords(context.records, { from, to }),
    };
  }

  async month(userId: string, requested?: Partial<MonthRef>): Promise<MonthInsightsDto> {
    if ((requested?.year === undefined) !== (requested?.month === undefined)) {
      throw badRequest('Give both year and month, or neither for the current month.');
    }
    await this.closure.closeEndedMonths(userId);
    const today = await this.userToday.today(userId);
    const current = monthOf(today);
    const month =
      requested?.year !== undefined && requested.month !== undefined
        ? { year: requested.year, month: requested.month }
        : current;
    if (monthIndex(month) > monthIndex(current)) {
      throw new NotFoundException('This month has not started yet.');
    }
    const from = firstDateOfMonth(month);
    const to = lastDateOfMonth(month);
    const scope = { month };
    // Local-date focus over every day of the month's weeks, for day cells and weekly goals.
    const calendar = await this.stats.scopeDays(userId, {
      from: weekStartOf(from),
      to: addDays(weekStartOf(to), 6),
    });
    const attributed = await this.stats.scopeDays(userId, scope);
    const context = await this.context(userId);
    const cells = dayCells({
      from,
      to,
      today,
      days: calendar,
      restDates: context.restDates,
      dailyVersions: context.versions.daily,
    });
    const tree = await this.prisma.monthlyTree.findUnique({
      where: { userId_year_month: { userId, ...month } },
      select: { status: true, archive: true },
    });
    const archived = tree?.status === 'archived';
    const topics = await this.topics(userId, scope);
    return {
      period: {
        kind: 'month',
        ...month,
        from,
        to,
        current: monthIndex(month) === monthIndex(current),
        archived,
      },
      summary: summarize(attributed),
      topics,
      topTopic: topics[0] ?? null,
      longestSession: await this.longest(userId, scope),
      mostProductiveDay: mostProductiveDay(attributed, month),
      mostProductiveWeek: mostProductiveWeek(attributed, month),
      days: cells,
      goals: {
        daily: dailyGoalRate(cells),
        weekly: weeklyGoalRate({
          month,
          today,
          days: calendar,
          weeklyVersions: context.versions.weekly,
        }),
      },
      restDays: cells.filter((cell) => cell.rest).length,
      streak: periodStreak(context.history, today, from, to),
      newRecords: newPersonalRecords(context.records, { from, to }),
      archivedStats: archived ? parseTreeArchive(tree.archive).stats : null,
    };
  }

  /** Day cells for [from, to], by default the last 365 days; never past today. */
  async heatmap(userId: string, query: { from?: string; to?: string }): Promise<HeatmapDto> {
    const today = await this.userToday.today(userId);
    for (const value of [query.from, query.to]) {
      if (value !== undefined && !isLocalDate(value)) badRequestThrow('Dates must be YYYY-MM-DD.');
    }
    const requestedTo = query.to ?? today;
    const to = compareLocalDates(requestedTo, today) > 0 ? today : requestedTo;
    const from = query.from ?? addDays(to, -(HEATMAP_DEFAULT_DAYS - 1));
    if (compareLocalDates(from, to) > 0) badRequestThrow('from must not be after to.');
    if (daysBetween(from, to) + 1 > HEATMAP_MAX_DAYS) {
      badRequestThrow(`The heatmap covers at most ${HEATMAP_MAX_DAYS} days.`);
    }
    const days = await this.stats.scopeDays(userId, { from, to });
    const [restDates, versions] = [
      await this.restDays.allDates(userId),
      await this.goals.versions(userId),
    ];
    return {
      from,
      to,
      days: dayCells({ from, to, today, days, restDates, dailyVersions: versions.daily }),
    };
  }

  /** The user's personal records as of today. */
  async records(userId: string): Promise<RecordsDto> {
    const today = await this.userToday.today(userId);
    return { records: personalRecords((await this.context(userId)).records, today) };
  }

  /** Lifetime stats for the profile, from every counted session, late ones included. */
  async lifetime(userId: string): Promise<LifetimeStatsDto> {
    await this.closure.closeEndedMonths(userId);
    const today = await this.userToday.today(userId);
    const lifetime = await this.stats.lifetime(userId);
    const streak = summarizeStreak(await this.streak.history(userId), today);
    return {
      ...lifetime,
      currentStreak: streak.current,
      longestStreak: streak.longest,
      archivedTreeCount: await this.prisma.monthlyTree.count({
        where: { userId, status: 'archived' },
      }),
    };
  }

  /** Everything a period needs beyond its own focus: goals, rest days, streak, records. */
  private async context(userId: string) {
    const versions = await this.goals.versions(userId);
    const history = await this.streak.history(userId);
    const allDays = await this.stats.allDays(userId);
    const records: RecordsInput = {
      days: allDays,
      longestSessions: await this.stats.longestSessionsByDay(userId),
      activity: history,
      goalMetDates: goalMetDates(allDays, versions.daily),
    };
    return { versions, history, restDates: history.restDates, records };
  }

  private async topics(userId: string, scope: SessionScope): Promise<TopicInsightDto[]> {
    const focus = await this.stats.scopeTopics(userId, scope);
    if (focus.length === 0) return [];
    const topics = await this.prisma.topic.findMany({
      where: { userId, id: { in: focus.map((entry) => entry.topicId) } },
      select: { id: true, name: true, icon: true, color: true, status: true },
    });
    const byId = new Map(topics.map((topic) => [topic.id, topic]));
    // Sessions always point at a stored topic; one that did not would be skipped, not crash.
    return topicShares(focus).flatMap((entry) => {
      const topic = byId.get(entry.topicId);
      if (!topic) return [];
      return [
        {
          topicId: entry.topicId,
          name: topic.name,
          icon: topic.icon,
          color: topic.color,
          status: topic.status,
          focusedMilliseconds: entry.focusedMilliseconds,
          sessionCount: entry.sessionCount,
          share: entry.share,
          lastUsedAt: entry.lastStartedAt.toISOString(),
        },
      ];
    });
  }

  private async longest(userId: string, scope: SessionScope): Promise<LongestSessionDto | null> {
    const session = await this.stats.longestSession(userId, scope);
    return (
      session && {
        sessionId: session.id,
        topicId: session.topicId,
        localDate: session.localDate.toISOString().slice(0, 10),
        focusedMilliseconds: session.focusedMilliseconds,
      }
    );
  }
}

function summarize(days: readonly DayFocus[]): FocusSummaryDto {
  const counted = days.filter((day) => day.sessionCount > 0);
  const focusedMilliseconds = counted.reduce((sum, day) => sum + day.focusedMilliseconds, 0);
  return {
    focusedMilliseconds,
    sessionCount: counted.reduce((sum, day) => sum + day.sessionCount, 0),
    activeDays: counted.length,
    averageFocusedMillisecondsPerActiveDay: averagePerActiveDay(
      focusedMilliseconds,
      counted.length,
    ),
  };
}

function periodStreak(
  history: ActivityHistory,
  today: LocalDate,
  from: LocalDate,
  to: LocalDate,
): PeriodStreakDto {
  const summary = summarizeStreak(history, today);
  const end = compareLocalDates(to, today) < 0 ? to : today;
  return {
    current: summary.current,
    longest: summary.longest,
    longestInPeriod: compareLocalDates(from, end) > 0 ? 0 : longestStreakWithin(history, from, end),
  };
}

function monthOf(date: LocalDate): MonthRef {
  const [year = 0, month = 1] = date.split('-').map(Number);
  return { year, month };
}

function badRequest(message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', message });
}

function badRequestThrow(message: string): never {
  throw badRequest(message);
}
