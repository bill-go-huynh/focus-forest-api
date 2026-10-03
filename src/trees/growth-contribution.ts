import type { DayFocus } from '../focus-stats/focus-stats.js';
import type { GrowthRules } from './growth-rules.js';

type CapRules = Pick<GrowthRules, 'dailySoftCapMs' | 'overCapPercent'>;

/**
 * The growth one local day of focus adds (docs/03_TREE_SYSTEM.md §4, anti-grinding): focus up to
 * the daily soft cap counts in full, focus beyond it at the over-cap rate. Whole milliseconds.
 * The focus statistics themselves are never reduced.
 */
export function growthContributionForDay(focusedMilliseconds: number, rules: CapRules): number {
  if (focusedMilliseconds <= rules.dailySoftCapMs) return focusedMilliseconds;
  const excess = focusedMilliseconds - rules.dailySoftCapMs;
  return rules.dailySoftCapMs + Math.floor((excess * rules.overCapPercent) / 100);
}

/** The growth of a month: the cap applies to each local day separately. */
export function monthGrowthMilliseconds(days: readonly DayFocus[], rules: CapRules): number {
  return days.reduce(
    (sum, day) => sum + growthContributionForDay(day.focusedMilliseconds, rules),
    0,
  );
}
