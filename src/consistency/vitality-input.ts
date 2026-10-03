import type { LocalDate } from '../common/local-date.js';
import type { VitalityInput } from '../trees/vitality.js';
import type { ActivityHistory } from './streak.js';

/**
 * Vitality reads real focus and planned rest only. Recovered days repair the streak and are
 * deliberately left out, so a recovery never makes the tree look more alive.
 */
export function vitalityInputFor(
  today: LocalDate,
  history: ActivityHistory,
  goalMetDates: readonly LocalDate[],
): VitalityInput {
  return {
    today,
    activeDates: [...history.activeDates],
    restDates: [...history.restDates],
    goalMetDates: [...goalMetDates],
  };
}
