/**
 * The values the migrations activate, for tests that create their own configuration versions.
 * An integration test checks that the active version after all migrations equals these.
 * Domain code never imports this: it reads ProductConfig.
 */

export const SESSION_CONFIG_VALUES = {
  'session.minValidMinutes': 5,
  'session.maxPauseMinutes': 30,
} as const;

/** Phase 3 tree growth and vitality (configuration version 3). */
export const TREE_CONFIG_VALUES = {
  'growth.stageThresholds': [120, 360, 720, 1200, 1800],
  'growth.dailySoftCap': 240,
  'growth.overCapRate': 40,
  'growth.firstMonthProration': { floorPercent: 25 },
  'growth.fullnessWeights': { activeDays: 60, weeklyConsistency: 40 },
  'growth.fullnessTargets': { activeDays: 24, activeDaysPerWeek: 3 },
  'growth.fullnessLevels': [15, 35, 55, 75, 95],
  'growth.blossomPoints': { dailyGoal: 1, weeklyGoal: 2 },
  'growth.blossomThresholds': [1, 3, 6, 10, 15, 21, 28],
  'growth.richnessTiers': [180, 360, 600, 900, 1260],
  'growth.focusHourMilestones': [10, 25, 40],
  'vitality.rules': { thrivingActiveRunDays: 2, healthyWithinDays: 1, stableWithinDays: 2 },
} as const;

/** Phase 3 goals, rest days, streaks, recovery, and goal-based vitality (configuration version 4). */
export const CONSISTENCY_CONFIG_VALUES = {
  'goal.dailyDefaultMinutes': 30,
  'restDay.maxPerWeek': 2,
  'restDay.allowSameDay': true,
  'streak.milestones': [3, 7, 14, 30, 60, 100],
  'recovery.mechanics': { nextDaySession: { minPreviousStreak: 3 } },
  'recovery.limit': { perMonth: 1 },
  'vitality.goalConsistency': { windowDays: 4, metDaysRequired: 3 },
} as const;

/** Phase 3 month closure and forest progression (configuration version 5). */
export const FOREST_CONFIG_VALUES = {
  'session.monthGraceMinutes': 180,
  'forest.levelThresholds': [1, 3, 6, 12, 24],
  'forest.areaLevels': { lake: 2, mountains: 3, night: 4, seasonal: 5, decorations: 6 },
} as const;

export const CURRENT_CONFIG_VALUES = {
  ...SESSION_CONFIG_VALUES,
  ...TREE_CONFIG_VALUES,
  ...CONSISTENCY_CONFIG_VALUES,
  ...FOREST_CONFIG_VALUES,
};

/** A complete set of values: the current ones with some replaced. */
export function configValues(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...CURRENT_CONFIG_VALUES, ...overrides };
}
