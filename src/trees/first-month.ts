import {
  compareLocalDates,
  daysBetween,
  daysInMonth,
  firstDateOfMonth,
  lastDateOfMonth,
  type LocalDate,
} from '../common/local-date.js';
import type { MonthRef } from '../sessions/attribution/calendar.js';

export interface Fraction {
  numerator: number;
  denominator: number;
}

export interface FirstMonthFactor extends Fraction {
  /** The user joined after the month's first day. */
  partial: boolean;
}

const WHOLE: Fraction = { numerator: 1, denominator: 1 };

/**
 * How a partial first month scales its growth thresholds (docs/03_TREE_SYSTEM.md §3):
 * days remaining, the join day included, over the days in the month, never below the floor.
 *
 * `joinedOn` is the user's join date (User.createdAt) as a local date in the month's time zone.
 * It is supplied by the caller, never guessed from the first session.
 */
export function firstMonthFactor(
  month: MonthRef,
  joinedOn: LocalDate,
  floorPercent: number,
): FirstMonthFactor {
  if (compareLocalDates(joinedOn, firstDateOfMonth(month)) <= 0) {
    return { partial: false, ...WHOLE };
  }
  const total = daysInMonth(month);
  const remaining = Math.max(0, daysBetween(joinedOn, lastDateOfMonth(month)) + 1);
  // remaining / total < floor / 100, compared without division.
  if (remaining * 100 < floorPercent * total) {
    return { partial: true, numerator: floorPercent, denominator: 100 };
  }
  return { partial: true, numerator: remaining, denominator: total };
}

/** A threshold scaled by the factor, rounded up to a whole unit, and at least 1. */
export function prorate(value: number, factor: Fraction): number {
  return Math.max(1, Math.ceil((value * factor.numerator) / factor.denominator));
}
