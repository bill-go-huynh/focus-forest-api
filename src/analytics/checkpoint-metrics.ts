import { daysBetween, type LocalDate } from '../common/local-date.js';

/**
 * Core Loop Checkpoint metrics (CR.2; docs/12 ★: "multi-day use per month, return after gaps,
 * second-month return after the first archive"). Derived on every read from analytics events
 * and stored sessions, never stored. Pure.
 *
 * An active day is a local date with an app open or foreground event or a counted session. A
 * gap is at least `GAP_DAYS` days without activity between two active days.
 */

export const GAP_DAYS = 3;
/** Multi-day use: at least this many active days in a month. */
export const MULTI_DAY = 2;

export interface MonthRef {
  year: number;
  month: number;
}

export interface UserActivity {
  userId: string;
  /** The local date of sign-up. */
  joinedOn: LocalDate;
  /** The user's local today. */
  today: LocalDate;
  /** Distinct local dates with an app open or foreground. */
  openDates: readonly LocalDate[];
  /** Distinct local dates with a counted session. */
  focusDates: readonly LocalDate[];
  /** The earliest archived month (a tree that was planted), if any. */
  firstArchive: MonthRef | null;
}

export interface MonthActivity extends MonthRef {
  activeDays: number;
  focusDays: number;
}

export interface UserMetrics {
  userId: string;
  joinedOn: LocalDate;
  months: MonthActivity[];
  activeDays: number;
  /** Returns after a gap of `GAP_DAYS` or more days. */
  gapReturns: number;
  firstArchive: MonthRef | null;
  /**
   * Active in the month after the first archive: true or false once known, null while that month
   * has not ended without activity yet (or there is no archive).
   */
  secondMonthReturn: boolean | null;
  lastActiveOn: LocalDate | null;
  daysSinceLastActive: number | null;
}

const monthOf = (date: LocalDate): MonthRef => ({
  year: Number(date.slice(0, 4)),
  month: Number(date.slice(5, 7)),
});
const monthKey = ({ year, month }: MonthRef) => year * 12 + (month - 1);
const nextMonth = ({ year, month }: MonthRef): MonthRef =>
  month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };

export function userMetrics(activity: UserActivity): UserMetrics {
  const focus = new Set(activity.focusDates);
  const active = [...new Set([...activity.openDates, ...activity.focusDates])].sort();

  const byMonth = new Map<number, MonthActivity>();
  for (const date of active) {
    const ref = monthOf(date);
    const row = byMonth.get(monthKey(ref)) ?? { ...ref, activeDays: 0, focusDays: 0 };
    row.activeDays += 1;
    if (focus.has(date)) row.focusDays += 1;
    byMonth.set(monthKey(ref), row);
  }

  let gapReturns = 0;
  for (let i = 1; i < active.length; i += 1) {
    if (daysBetween(active[i - 1]!, active[i]!) - 1 >= GAP_DAYS) gapReturns += 1;
  }

  let secondMonthReturn: boolean | null = null;
  if (activity.firstArchive) {
    const after = nextMonth(activity.firstArchive);
    const returned = active.some((date) => monthKey(monthOf(date)) === monthKey(after));
    const ended = monthKey(monthOf(activity.today)) > monthKey(after);
    secondMonthReturn = returned ? true : ended ? false : null;
  }

  const lastActiveOn = active.at(-1) ?? null;
  return {
    userId: activity.userId,
    joinedOn: activity.joinedOn,
    months: [...byMonth.values()],
    activeDays: active.length,
    gapReturns,
    firstArchive: activity.firstArchive,
    secondMonthReturn,
    lastActiveOn,
    daysSinceLastActive: lastActiveOn ? daysBetween(lastActiveOn, activity.today) : null,
  };
}

export interface CohortMetrics {
  users: number;
  /** Users with `MULTI_DAY`+ active days in the month they joined. */
  multiDayFirstMonth: number;
  /** Users who came back at least once after a gap. */
  returnedAfterGap: number;
  /** Users whose month after the first archive is decided, and those who returned in it. */
  secondMonth: { decided: number; returned: number };
  /** The median of active days in the month each user joined. */
  medianFirstMonthActiveDays: number | null;
}

/** Counts, never percentages: the checkpoint reads small numbers of known testers. */
export function cohortMetrics(users: readonly UserMetrics[]): CohortMetrics {
  const firstMonthDays = users.map((user) => {
    const joined = monthOf(user.joinedOn);
    return user.months.find((m) => monthKey(m) === monthKey(joined))?.activeDays ?? 0;
  });
  const decided = users.filter((user) => user.secondMonthReturn !== null);
  return {
    users: users.length,
    multiDayFirstMonth: firstMonthDays.filter((days) => days >= MULTI_DAY).length,
    returnedAfterGap: users.filter((user) => user.gapReturns > 0).length,
    secondMonth: {
      decided: decided.length,
      returned: decided.filter((user) => user.secondMonthReturn).length,
    },
    medianFirstMonthActiveDays: median(firstMonthDays),
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
