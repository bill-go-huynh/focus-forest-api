import {
  addDays,
  compareLocalDates,
  firstDateOfMonth,
  lastDateOfMonth,
  weekStartOf,
  type LocalDate,
} from '../common/local-date.js';
import type { DayFocus } from '../focus-stats/focus-stats.js';
import type { MonthRef } from '../sessions/attribution/calendar.js';

/**
 * Daily and weekly goals (docs/06_DOMAIN_MODEL.md → DailyGoal, WeeklyGoal). Goals are versioned
 * by the date they take effect, so a later change never reinterprets a past day or week.
 */

const MINUTE_MS = 60_000;

export const WEEKLY_GOAL_TYPES = ['focused_minutes', 'session_count'] as const;
export type WeeklyGoalType = (typeof WEEKLY_GOAL_TYPES)[number];

export interface DailyGoalVersion {
  effectiveFrom: LocalDate;
  minutes: number;
}

export interface WeeklyGoal {
  type: WeeklyGoalType;
  target: number;
}

export interface WeeklyGoalVersion {
  /** Always a Monday. */
  effectiveFrom: LocalDate;
  /** Null: the user cleared the weekly goal from this week on. */
  goal: WeeklyGoal | null;
}

/** A first daily goal applies today; a change applies from the next local day. */
export function dailyEffectiveFrom(today: LocalDate, { firstSetting }: { firstSetting: boolean }) {
  return firstSetting ? today : addDays(today, 1);
}

/**
 * A weekly goal set while none is in effect (never set, or cleared) applies to the current week;
 * changing or clearing a goal in effect applies from the next Monday.
 */
export function weeklyEffectiveFrom(today: LocalDate, { goalInEffect }: { goalInEffect: boolean }) {
  const monday = weekStartOf(today);
  return goalInEffect ? addDays(monday, 7) : monday;
}

/** The version in effect on `date`: the one with the latest effectiveFrom on or before it. */
export function versionOn<T extends { effectiveFrom: LocalDate }>(
  versions: readonly T[],
  date: LocalDate,
): T | null {
  let found: T | null = null;
  for (const version of versions) {
    if (compareLocalDates(version.effectiveFrom, date) > 0) continue;
    if (!found || compareLocalDates(version.effectiveFrom, found.effectiveFrom) > 0)
      found = version;
  }
  return found;
}

/**
 * The daily goal in effect on a date, or null before the user's first persisted daily goal.
 * The configured default is only what the app shows until then; it is never history, so a
 * later configuration change cannot re-score past days.
 */
export function dailyGoalMinutesOn(
  versions: readonly DailyGoalVersion[],
  date: LocalDate,
): number | null {
  return versionOn(versions, date)?.minutes ?? null;
}

/** The weekly goal of the week starting on `weekStart`, or null when there was none. */
export function weeklyGoalForWeek(
  versions: readonly WeeklyGoalVersion[],
  weekStart: LocalDate,
): WeeklyGoal | null {
  return versionOn(versions, weekStart)?.goal ?? null;
}

export interface DailyProgress {
  date: LocalDate;
  targetMinutes: number;
  focusedMinutes: number;
  remainingMinutes: number;
  completed: boolean;
}

export function dailyProgress(
  date: LocalDate,
  focusedMilliseconds: number,
  targetMinutes: number,
): DailyProgress {
  const targetMs = targetMinutes * MINUTE_MS;
  return {
    date,
    targetMinutes,
    focusedMinutes: Math.floor(focusedMilliseconds / MINUTE_MS),
    remainingMinutes: Math.ceil(Math.max(0, targetMs - focusedMilliseconds) / MINUTE_MS),
    completed: focusedMilliseconds >= targetMs,
  };
}

export interface WeeklyProgress {
  weekStart: LocalDate;
  type: WeeklyGoalType;
  target: number;
  /** Focused minutes or counted sessions so far. */
  current: number;
  completed: boolean;
}

/** Progress of one Monday-to-Sunday week, from counted focus per day (other days ignored). */
export function weeklyProgress(
  weekStart: LocalDate,
  days: readonly DayFocus[],
  goal: WeeklyGoal,
): WeeklyProgress {
  const inWeek = days.filter((day) => weekStartOf(day.date) === weekStart);
  const focusedMs = inWeek.reduce((sum, day) => sum + day.focusedMilliseconds, 0);
  const sessions = inWeek.reduce((sum, day) => sum + day.sessionCount, 0);
  return {
    weekStart,
    type: goal.type,
    target: goal.target,
    current: goal.type === 'focused_minutes' ? Math.floor(focusedMs / MINUTE_MS) : sessions,
    completed: reached(goal, focusedMs, sessions),
  };
}

function reached(goal: WeeklyGoal, focusedMs: number, sessions: number): boolean {
  return goal.type === 'focused_minutes'
    ? focusedMs >= goal.target * MINUTE_MS
    : sessions >= goal.target;
}

/** Dates whose counted focus met the daily goal in effect that day, in date order. */
export function goalMetDates(
  days: readonly DayFocus[],
  versions: readonly DailyGoalVersion[],
): LocalDate[] {
  return days
    .filter((day) => day.sessionCount > 0)
    .filter((day) => {
      const minutes = dailyGoalMinutesOn(versions, day.date);
      return minutes !== null && day.focusedMilliseconds >= minutes * MINUTE_MS;
    })
    .map((day) => day.date)
    .sort(compareLocalDates);
}

export interface MonthGoalInput {
  month: MonthRef;
  /** Counted focus per local date, covering the month and the weeks it touches. */
  days: readonly DayFocus[];
  dailyVersions: readonly DailyGoalVersion[];
  weeklyVersions: readonly WeeklyGoalVersion[];
}

export interface MonthGoalCompletions {
  daily: number;
  weekly: number;
  dailyMetDates: LocalDate[];
}

/**
 * Goals met in a calendar month (the tree's blossom input). Each day is judged by the daily goal
 * in effect that day; each week by the weekly goal in effect that week, counted in the month of
 * the day the target was reached.
 */
export function monthGoalCompletions(input: MonthGoalInput): MonthGoalCompletions {
  const first = firstDateOfMonth(input.month);
  const last = lastDateOfMonth(input.month);
  const inMonth = (date: LocalDate) =>
    compareLocalDates(date, first) >= 0 && compareLocalDates(date, last) <= 0;
  const days = input.days
    .filter((day) => day.sessionCount > 0)
    .sort((a, b) => compareLocalDates(a.date, b.date));

  const dailyMetDates = goalMetDates(
    days.filter((day) => inMonth(day.date)),
    input.dailyVersions,
  );

  // Walk each week's days in order; the week is met on the day its total reaches the target.
  let weekly = 0;
  const totals = new Map<LocalDate, { focusedMs: number; sessions: number; met: boolean }>();
  for (const day of days) {
    const weekStart = weekStartOf(day.date);
    const goal = weeklyGoalForWeek(input.weeklyVersions, weekStart);
    if (!goal) continue;
    const total = totals.get(weekStart) ?? { focusedMs: 0, sessions: 0, met: false };
    total.focusedMs += day.focusedMilliseconds;
    total.sessions += day.sessionCount;
    if (!total.met && reached(goal, total.focusedMs, total.sessions)) {
      total.met = true;
      if (inMonth(day.date)) weekly += 1;
    }
    totals.set(weekStart, total);
  }

  return { daily: dailyMetDates.length, weekly, dailyMetDates };
}
