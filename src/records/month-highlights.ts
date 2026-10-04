import {
  compareLocalDates,
  firstDateOfMonth,
  lastDateOfMonth,
  weekStartOf,
  type LocalDate,
} from '../common/local-date.js';
import { streakRunDays, type ActivityHistory } from '../consistency/streak.js';
import type { DayFocus } from '../focus-stats/focus-stats.js';
import type { MonthRef } from '../sessions/attribution/calendar.js';

/**
 * A month's highlights for its recap (docs/06_DOMAIN_MODEL.md → MonthlyRecap), from counted focus
 * per local date. Ties go to the earliest day or week, so the answer never depends on row order.
 */

const MINUTE_MS = 60_000;

export interface ProductiveDay {
  date: LocalDate;
  focusedMinutes: number;
}

export interface ProductiveWeek {
  /** The Monday the week starts on; it may be in the previous month. */
  weekStart: LocalDate;
  focusedMinutes: number;
}

function monthDaysOf(days: readonly DayFocus[], month: MonthRef): DayFocus[] {
  const first = firstDateOfMonth(month);
  const last = lastDateOfMonth(month);
  return days
    .filter(
      (day) => compareLocalDates(day.date, first) >= 0 && compareLocalDates(day.date, last) <= 0,
    )
    .filter((day) => day.focusedMilliseconds > 0)
    .sort((a, b) => compareLocalDates(a.date, b.date));
}

/** The month's day with the most counted focus. */
export function mostProductiveDay(
  days: readonly DayFocus[],
  month: MonthRef,
): ProductiveDay | null {
  let best: DayFocus | null = null;
  for (const day of monthDaysOf(days, month)) {
    if (!best || day.focusedMilliseconds > best.focusedMilliseconds) best = day;
  }
  return (
    best && { date: best.date, focusedMinutes: Math.floor(best.focusedMilliseconds / MINUTE_MS) }
  );
}

/**
 * The Monday-to-Sunday week with the most counted focus on the month's own days: a week that
 * starts or ends in another month counts only its days in this month.
 */
export function mostProductiveWeek(
  days: readonly DayFocus[],
  month: MonthRef,
): ProductiveWeek | null {
  const totals = new Map<LocalDate, number>();
  for (const day of monthDaysOf(days, month)) {
    const weekStart = weekStartOf(day.date);
    totals.set(weekStart, (totals.get(weekStart) ?? 0) + day.focusedMilliseconds);
  }
  let best: { weekStart: LocalDate; ms: number } | null = null;
  // Map order follows the sorted days, so the earliest week is seen first.
  for (const [weekStart, ms] of totals) {
    if (!best || ms > best.ms) best = { weekStart, ms };
  }
  return best && { weekStart: best.weekStart, focusedMinutes: Math.floor(best.ms / MINUTE_MS) };
}

/**
 * The longest streak reached on any day from `from` to `to`, in active days. A run that began
 * before `from` counts whole; runs after `to` are ignored.
 */
export function longestStreakWithin(
  history: ActivityHistory,
  from: LocalDate,
  to: LocalDate,
): number {
  let longest = 0;
  for (const { date, count } of streakRunDays(history, to)) {
    if (compareLocalDates(date, from) >= 0) longest = Math.max(longest, count);
  }
  return longest;
}
