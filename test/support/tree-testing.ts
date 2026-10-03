import { configValues } from './product-config-values.js';
import { productConfigRegistry } from '../../src/product-config/product-config.registry.js';
import { ProductConfig } from '../../src/product-config/product-config.js';
import type { DayFocus } from '../../src/focus-stats/focus-stats.js';
import { addDays, type LocalDate } from '../../src/common/local-date.js';
import { growthRulesFrom, vitalityRulesFrom } from '../../src/trees/growth-rules.js';

// Helpers for the tree specs.

export const MIN = 60_000;
export const HOUR = 60 * MIN;

export function configWith(overrides: Record<string, unknown> = {}) {
  return new ProductConfig(3, configValues(overrides), productConfigRegistry);
}

/** Growth rules read from configuration: the current values with some replaced. */
export const rulesWith = (overrides: Record<string, unknown> = {}) =>
  growthRulesFrom(configWith(overrides));

export const vitalityRulesWith = (overrides: Record<string, unknown> = {}) =>
  vitalityRulesFrom(configWith(overrides));

export const day = (date: LocalDate, minutes: number, sessionCount = 1): DayFocus => ({
  date,
  focusedMilliseconds: Math.round(minutes * MIN),
  sessionCount,
});

/** `totalMs` spread over consecutive days from `from`, each day at most `perDayMs`. */
export function spread(totalMs: number, from: LocalDate, perDayMs = 4 * HOUR): DayFocus[] {
  const days: DayFocus[] = [];
  let left = totalMs;
  for (let index = 0; left > 0; index += 1) {
    const amount = Math.min(perDayMs, left);
    days.push({ date: addDays(from, index), focusedMilliseconds: amount, sessionCount: 1 });
    left -= amount;
  }
  return days;
}
