import { Type } from 'class-transformer';
import { IsInt, IsString, Max, Min, ValidateIf } from 'class-validator';

import type { LocalDate } from '../common/local-date.js';
import type { WeeklyProgress } from '../consistency/goals.js';
import type { TopicStatus } from '../generated/prisma/client.js';
import type { ProductiveDay, ProductiveWeek } from '../records/month-highlights.js';
import type { PersonalRecord } from '../records/personal-records.js';
import type { ArchivedMonthStatsDto } from '../trees/tree-archive.js';
import type { DayCell, GoalRate } from './insights.js';

/**
 * Insights contracts (A3.5) for the mobile Insights, Profile, and Home screens. Durations are
 * integer milliseconds unless a field name says minutes; nothing is formatted for display.
 */

const isSent = (key: string) => (dto: object) =>
  (dto as Record<string, unknown>)[key] !== undefined;

/** The heatmap returns at most this many days (a year and a week). */
export const HEATMAP_MAX_DAYS = 371;
export const HEATMAP_DEFAULT_DAYS = 365;

export class WeekQuery {
  /** The Monday of the week; the current week when absent. */
  @ValidateIf(isSent('weekStart'))
  @IsString({ message: 'weekStart must be YYYY-MM-DD.' })
  weekStart?: string;
}

export class MonthQuery {
  @ValidateIf(isSent('year'))
  @Type(() => Number)
  @IsInt({ message: 'year must be a whole number.' })
  @Min(2000, { message: 'year must be a four-digit year from 2000.' })
  @Max(9999, { message: 'year must be a four-digit year.' })
  year?: number;

  @ValidateIf(isSent('month'))
  @Type(() => Number)
  @IsInt({ message: 'month must be a whole number.' })
  @Min(1, { message: 'month must be from 1 to 12.' })
  @Max(12, { message: 'month must be from 1 to 12.' })
  month?: number;
}

export class HeatmapQuery {
  @ValidateIf(isSent('from'))
  @IsString({ message: 'from must be YYYY-MM-DD.' })
  from?: string;

  @ValidateIf(isSent('to'))
  @IsString({ message: 'to must be YYYY-MM-DD.' })
  to?: string;
}

export interface FocusSummaryDto {
  focusedMilliseconds: number;
  sessionCount: number;
  activeDays: number;
  /** Over active days only; null without one. */
  averageFocusedMillisecondsPerActiveDay: number | null;
}

/** A topic's focus in the period. Archived topics keep their history. */
export interface TopicInsightDto {
  topicId: string;
  name: string;
  icon: string;
  color: string;
  status: TopicStatus;
  focusedMilliseconds: number;
  sessionCount: number;
  /** Of the period's counted focus, 0 to 1, four decimals. */
  share: number;
  /** The topic's latest counted session start in the period. */
  lastUsedAt: string;
}

export interface LongestSessionDto {
  sessionId: string;
  topicId: string;
  localDate: LocalDate;
  focusedMilliseconds: number;
}

export interface PeriodStreakDto {
  current: number;
  longest: number;
  /** The longest streak reached on a day of the period (up to today). */
  longestInPeriod: number;
}

/** Monday to Sunday, from sessions by their stored local date. */
export interface WeekInsightsDto {
  period: { kind: 'week'; from: LocalDate; to: LocalDate; current: boolean };
  summary: FocusSummaryDto;
  /** Seven cells, Monday first. */
  days: DayCell[];
  topics: TopicInsightDto[];
  longestSession: LongestSessionDto | null;
  goals: {
    daily: GoalRate;
    /** The week's weekly goal and progress; null when it had none. */
    weekly: WeeklyProgress | null;
  };
  restDays: number;
  streak: PeriodStreakDto;
  /** Personal records set in the period, as of now. */
  newRecords: PersonalRecord[];
}

/**
 * A calendar month. Focus numbers (summary, topics, longest session, productive day and week)
 * count the sessions attributed to the month, as the tree does; day cells, the daily goal rate,
 * and rest days follow the month's local dates; the weekly goal rate owns each week by its
 * Monday. Late sessions of a closed month count here; `archivedStats` is the archive's frozen
 * snapshot, which they never change.
 */
export interface MonthInsightsDto {
  period: {
    kind: 'month';
    year: number;
    month: number;
    from: LocalDate;
    to: LocalDate;
    current: boolean;
    archived: boolean;
  };
  summary: FocusSummaryDto;
  topics: TopicInsightDto[];
  topTopic: TopicInsightDto | null;
  longestSession: LongestSessionDto | null;
  mostProductiveDay: ProductiveDay | null;
  mostProductiveWeek: ProductiveWeek | null;
  days: DayCell[];
  goals: { daily: GoalRate; weekly: GoalRate };
  restDays: number;
  streak: PeriodStreakDto;
  newRecords: PersonalRecord[];
  archivedStats: ArchivedMonthStatsDto | null;
}

export interface HeatmapDto {
  from: LocalDate;
  to: LocalDate;
  days: DayCell[];
}

export interface RecordsDto {
  /** The user's records as of today, in a fixed order; none before any focus. */
  records: PersonalRecord[];
}

/** Profile lifetime stats; the join date is the profile's `joinDate`. */
export interface LifetimeStatsDto {
  focusedMilliseconds: number;
  sessionCount: number;
  currentStreak: number;
  longestStreak: number;
  archivedTreeCount: number;
}
