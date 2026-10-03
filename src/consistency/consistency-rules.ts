import type { ProductConfig } from '../product-config/product-config.js';
import type { ProductConfigRegistry } from '../product-config/product-config.registry.js';
import type { RecoveryRules } from './recovery.js';
import type { RestDayRules } from './rest-days.js';

/** Goals, rest days, streaks, and recovery rules of one configuration version. */
export interface ConsistencyRules {
  configVersion: number;
  dailyGoalDefaultMinutes: number;
  restDays: RestDayRules;
  streakMilestones: readonly number[];
  recovery: RecoveryRules;
}

export function consistencyRulesFrom(
  config: ProductConfig<ProductConfigRegistry>,
): ConsistencyRules {
  return {
    configVersion: config.version,
    dailyGoalDefaultMinutes: config.get('goal.dailyDefaultMinutes'),
    restDays: {
      maxPerWeek: config.get('restDay.maxPerWeek'),
      allowSameDay: config.get('restDay.allowSameDay'),
    },
    streakMilestones: [...config.get('streak.milestones')],
    recovery: {
      minPreviousStreak: config.get('recovery.mechanics').nextDaySession.minPreviousStreak,
      perMonth: config.get('recovery.limit').perMonth,
    },
  };
}
