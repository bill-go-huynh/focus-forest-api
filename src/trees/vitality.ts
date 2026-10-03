import { addDays, compareLocalDates, type LocalDate } from '../common/local-date.js';
import type { VitalityRules } from './growth-rules.js';

/** The five vitality states (docs/03_TREE_SYSTEM.md §6). The only non-permanent dimension. */
export const VITALITY_STATES = ['thriving', 'healthy', 'stable', 'quiet', 'recovering'] as const;

export type VitalityState = (typeof VITALITY_STATES)[number];

export interface VitalityInput {
  /** The user's current local date: passed in, never read from a clock. */
  today: LocalDate;
  /** Dates with at least one counted session. Recovered streak days are not active dates. */
  activeDates: readonly LocalDate[];
  /** Planned rest days: neither a day without focus nor a day of a run. */
  restDates: readonly LocalDate[];
  /** Dates whose daily goal was met. Only real focus meets a goal; a recovered day never does. */
  goalMetDates: readonly LocalDate[];
}

/**
 * Vitality from recent activity. Days without focus are counted from the last active date up to
 * and including today, skipping planned rest days. Active today: Recovering if the user was
 * Quiet before today's focus, Thriving on a run of active days (rest days bridge it) or with the
 * daily goal met on enough of the last few days, otherwise Healthy. Not active today: Healthy, Stable, or Quiet by the number of days without focus.
 * It reads only activity, so it can never change anything the tree has earned.
 */
export function vitalityOn(input: VitalityInput, rules: VitalityRules): VitalityState {
  const active = new Set(input.activeDates);
  const rest = new Set(input.restDates);
  const earlier = input.activeDates
    .filter((date) => compareLocalDates(date, input.today) < 0)
    .sort(compareLocalDates);
  const lastBeforeToday = earlier[earlier.length - 1];
  const quietAfter = rules.stableWithinDays;

  if (active.has(input.today)) {
    if (
      lastBeforeToday &&
      daysWithoutFocus(lastBeforeToday, input.today, rest, quietAfter) > quietAfter
    ) {
      return 'recovering';
    }
    const onARun =
      activeRun(input.today, active, rest, rules.thrivingActiveRunDays) >=
      rules.thrivingActiveRunDays;
    return onARun || recentGoalDays(input, rules.goalWindowDays) >= rules.goalMetDaysRequired
      ? 'thriving'
      : 'healthy';
  }

  // Never active yet: a new tree, nothing to rest from.
  if (!lastBeforeToday) return 'healthy';
  const gap = daysWithoutFocus(lastBeforeToday, input.today, rest, quietAfter);
  if (gap <= rules.healthyWithinDays) return 'healthy';
  if (gap <= rules.stableWithinDays) return 'stable';
  return 'quiet';
}

/** Days after `last`, up to and including `today`, that are not rest days. Stops past `limit`. */
function daysWithoutFocus(
  last: LocalDate,
  today: LocalDate,
  rest: ReadonlySet<LocalDate>,
  limit: number,
): number {
  let count = 0;
  for (let date = addDays(last, 1); compareLocalDates(date, today) <= 0; date = addDays(date, 1)) {
    if (!rest.has(date)) count += 1;
    if (count > limit) break;
  }
  return count;
}

/** Active days in a row ending today; rest days bridge without counting. Stops at `enough`. */
function activeRun(
  today: LocalDate,
  active: ReadonlySet<LocalDate>,
  rest: ReadonlySet<LocalDate>,
  enough: number,
): number {
  let run = 0;
  for (let date = today; run < enough; date = addDays(date, -1)) {
    if (active.has(date)) run += 1;
    else if (!rest.has(date)) break;
  }
  return run;
}

/** Dates in the last `windowDays` local days, today included, whose daily goal was met. */
function recentGoalDays(input: VitalityInput, windowDays: number): number {
  const from = addDays(input.today, -(windowDays - 1));
  return new Set(
    input.goalMetDates.filter(
      (date) => compareLocalDates(date, from) >= 0 && compareLocalDates(date, input.today) <= 0,
    ),
  ).size;
}
