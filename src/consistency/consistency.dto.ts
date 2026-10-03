import { IsIn, IsInt, Max, Min, ValidateBy } from 'class-validator';

import { isLocalDate, type LocalDate } from '../common/local-date.js';
import type { DailyProgress, WeeklyGoal, WeeklyGoalType, WeeklyProgress } from './goals.js';
import { WEEKLY_GOAL_TYPES } from './goals.js';
import type { RecoveryOffer } from './recovery.js';

// Bounds are technical limits (a day, a week), not Product configuration.

export class DailyGoalDto {
  @IsInt({ message: 'minutes must be a whole number.' })
  @Min(1, { message: 'minutes must be at least 1.' })
  @Max(1440, { message: 'minutes can be at most 1440.' })
  minutes!: number;
}

const WEEKLY_TARGET_MAX: Record<WeeklyGoalType, number> = {
  focused_minutes: 10080, // a week
  session_count: 500,
};

export class WeeklyGoalDto {
  @IsIn(WEEKLY_GOAL_TYPES, { message: 'type must be one of: focused_minutes, session_count.' })
  type!: WeeklyGoalType;

  @IsInt({ message: 'target must be a whole number.' })
  @Min(1, { message: 'target must be at least 1.' })
  @ValidateBy({
    name: 'weeklyTargetMax',
    validator: {
      validate: (value, args) => {
        const max = WEEKLY_TARGET_MAX[(args?.object as WeeklyGoalDto).type];
        return max === undefined || (typeof value === 'number' && value <= max);
      },
      defaultMessage: (args) =>
        `target can be at most ${WEEKLY_TARGET_MAX[(args?.object as WeeklyGoalDto).type]} for this type.`,
    },
  })
  target!: number;
}

export class RecoveryDto {
  @ValidateBy({
    name: 'isLocalDate',
    validator: {
      validate: (value) => typeof value === 'string' && isLocalDate(value),
      defaultMessage: () => 'missedDate must be a calendar date, such as "2026-10-05".',
    },
  })
  missedDate!: LocalDate;
}

export interface GoalsResponse {
  daily: {
    /** The daily goal in effect today. */
    minutes: number;
    /** True until the user sets a daily goal: the configured default applies. */
    isDefault: boolean;
    /** A change that takes effect on a later date. */
    pending: { minutes: number; effectiveFrom: LocalDate } | null;
    today: DailyProgress;
  };
  weekly: {
    /** The weekly goal of this week; null when there is none. */
    goal: WeeklyGoal | null;
    /** A change from a later Monday; `goal: null` there means the goal ends then. */
    pending: { goal: WeeklyGoal | null; effectiveFrom: LocalDate } | null;
    /** Null when this week has no goal: no progress, nothing to complete. */
    thisWeek: WeeklyProgress | null;
  };
}

export interface RestDaysResponse {
  /** Rest days from this week's Monday on, in date order. */
  restDays: { date: LocalDate }[];
  /** This week's allowance (Monday to Sunday). */
  allowance: { perWeek: number; weekStart: LocalDate; used: number; remaining: number };
}

export interface StreakResponse {
  /** Active days in the current streak; rest and recovered days bridge it without counting. */
  current: number;
  longest: number;
  today: 'active' | 'rest' | 'pending';
  milestones: { reached: number[]; next: number | null };
  recovery: {
    /** The recovery the user can accept now, if any. */
    offer: RecoveryOffer | null;
    usedThisMonth: number;
    perMonth: number;
  };
}
