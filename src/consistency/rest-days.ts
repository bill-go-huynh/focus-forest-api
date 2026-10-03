import { addDays, compareLocalDates, weekStartOf, type LocalDate } from '../common/local-date.js';

/** Planned rest days (docs/06_DOMAIN_MODEL.md → RestDay). */

export interface RestDayRules {
  maxPerWeek: number;
  allowSameDay: boolean;
}

/** Technical bound on planning ahead, against unbounded input. Not Product configuration. */
export const REST_DAY_MAX_DAYS_AHEAD = 365;

export type RestDayRejection =
  | 'rest_day_in_past'
  | 'rest_day_today_not_allowed'
  | 'rest_day_too_far_ahead'
  | 'rest_allowance_used';

/**
 * Whether `date` can become a rest day. `existing` are the user's other rest days (any weeks);
 * the allowance counts those in the same Monday-to-Sunday week.
 */
export function checkNewRestDay(
  input: { date: LocalDate; today: LocalDate; existing: readonly LocalDate[] },
  rules: RestDayRules,
): RestDayRejection | null {
  const order = compareLocalDates(input.date, input.today);
  if (order < 0) return 'rest_day_in_past';
  if (order === 0 && !rules.allowSameDay) return 'rest_day_today_not_allowed';
  if (compareLocalDates(input.date, addDays(input.today, REST_DAY_MAX_DAYS_AHEAD)) > 0) {
    return 'rest_day_too_far_ahead';
  }
  const week = weekStartOf(input.date);
  const sameWeek = input.existing.filter(
    (date) => date !== input.date && weekStartOf(date) === week,
  ).length;
  return sameWeek >= rules.maxPerWeek ? 'rest_allowance_used' : null;
}

/** A rest day can be cancelled until it ends, which returns it to the allowance. */
export function checkCancelRestDay(input: {
  date: LocalDate;
  today: LocalDate;
}): 'rest_day_in_past' | null {
  return compareLocalDates(input.date, input.today) < 0 ? 'rest_day_in_past' : null;
}
