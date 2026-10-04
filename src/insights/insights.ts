import {
  addDays,
  compareLocalDates,
  firstDateOfMonth,
  lastDateOfMonth,
  weekStartOf,
  type LocalDate,
} from '../common/local-date.js';
import {
  dailyGoalMinutesOn,
  weeklyGoalForWeek,
  weeklyProgress,
  type DailyGoalVersion,
  type WeeklyGoalVersion,
} from '../consistency/goals.js';
import type { DayFocus } from '../focus-stats/focus-stats.js';
import type { MonthRef } from '../sessions/attribution/calendar.js';

/**
 * Pure Insights computations (docs/06_DOMAIN_MODEL.md → Insights): day cells for the heatmap and
 * period views, goal completion rates with explicit denominators, and topic shares. Everything
 * comes from counted focus per stored local date; nothing is stored.
 */

const MINUTE_MS = 60_000;

/**
 * The daily goal on a date: met; not met (the day is over); pending (today or later, not met
 * yet); none (no daily goal was in effect, for example before the first one was set).
 */
export type DailyGoalState = 'met' | 'not_met' | 'pending' | 'none';

export interface DayCell {
  date: LocalDate;
  focusedMilliseconds: number;
  sessionCount: number;
  /** Has counted focus. A rest day with focus is both active and a rest day. */
  active: boolean;
  rest: boolean;
  dailyGoal: DailyGoalState;
  /** The daily goal in effect that day, or null. */
  dailyGoalMinutes: number | null;
}

/** One cell per local date in [from, to], empty days included. */
export function dayCells(input: {
  from: LocalDate;
  to: LocalDate;
  today: LocalDate;
  days: readonly DayFocus[];
  restDates: readonly LocalDate[];
  dailyVersions: readonly DailyGoalVersion[];
}): DayCell[] {
  const byDate = new Map(input.days.map((day) => [day.date, day]));
  const rest = new Set(input.restDates);
  const cells: DayCell[] = [];
  for (let date = input.from; compareLocalDates(date, input.to) <= 0; date = addDays(date, 1)) {
    const day = byDate.get(date);
    const focusedMilliseconds = day?.focusedMilliseconds ?? 0;
    const sessionCount = day?.sessionCount ?? 0;
    const goal = dailyGoalMinutesOn(input.dailyVersions, date);
    let dailyGoal: DailyGoalState;
    if (goal === null) dailyGoal = 'none';
    else if (sessionCount > 0 && focusedMilliseconds >= goal * MINUTE_MS) dailyGoal = 'met';
    else if (compareLocalDates(date, input.today) >= 0) dailyGoal = 'pending';
    else dailyGoal = 'not_met';
    cells.push({
      date,
      focusedMilliseconds,
      sessionCount,
      active: sessionCount > 0,
      rest: rest.has(date),
      dailyGoal,
      dailyGoalMinutes: goal,
    });
  }
  return cells;
}

export interface GoalRate {
  completed: number;
  /** The denominator: completed plus the decided days or weeks that were not. */
  eligible: number;
}

/**
 * Daily goal completion over day cells: completed days, out of the days that had a goal and are
 * decided (met, or over). A rest day counts only when its goal was met anyway, so a planned rest
 * never lowers the rate. Days before the first daily goal and days still pending are left out.
 */
export function dailyGoalRate(cells: readonly DayCell[]): GoalRate {
  let completed = 0;
  let eligible = 0;
  for (const cell of cells) {
    if (cell.dailyGoal === 'met') {
      completed += 1;
      eligible += 1;
    } else if (cell.dailyGoal === 'not_met' && !cell.rest) {
      eligible += 1;
    }
  }
  return { completed, eligible };
}

/**
 * Weekly goal completion for a month's reporting: each Monday-to-Sunday week belongs to the
 * month of its Monday, and is judged on all its days, whatever month they are in. Weeks without a
 * goal are left out, and so is a week not over yet unless already met. (The tree's blossoms count
 * a met week in the month of the day it was met: a different, archived count.)
 */
export function weeklyGoalRate(input: {
  month: MonthRef;
  today: LocalDate;
  /** Counted focus per local date, covering every day of the month's weeks. */
  days: readonly DayFocus[];
  weeklyVersions: readonly WeeklyGoalVersion[];
}): GoalRate {
  let completed = 0;
  let eligible = 0;
  const last = lastDateOfMonth(input.month);
  let monday = weekStartOf(firstDateOfMonth(input.month));
  if (compareLocalDates(monday, firstDateOfMonth(input.month)) < 0) monday = addDays(monday, 7);
  for (; compareLocalDates(monday, last) <= 0; monday = addDays(monday, 7)) {
    const goal = weeklyGoalForWeek(input.weeklyVersions, monday);
    if (!goal) continue;
    const progress = weeklyProgress(monday, input.days, goal);
    if (progress.completed) {
      completed += 1;
      eligible += 1;
    } else if (compareLocalDates(addDays(monday, 6), input.today) < 0) {
      eligible += 1;
    }
  }
  return { completed, eligible };
}

/** Each entry's share of the entries' total focus, rounded to four decimals. */
export function topicShares<T extends { focusedMilliseconds: number }>(
  topics: readonly T[],
): (T & { share: number })[] {
  const total = topics.reduce((sum, topic) => sum + topic.focusedMilliseconds, 0);
  return topics.map((topic) => ({
    ...topic,
    share: total === 0 ? 0 : Math.round((topic.focusedMilliseconds / total) * 10_000) / 10_000,
  }));
}

/** Average focus per active day, in whole milliseconds; null without an active day. */
export function averagePerActiveDay(totalMs: number, activeDays: number): number | null {
  return activeDays === 0 ? null : Math.floor(totalMs / activeDays);
}
