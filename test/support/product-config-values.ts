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

/** Phase 5 challenge templates (configuration version 6, A5.5). */
export const CHALLENGE_CONFIG_VALUES = {
  'challenge.templates': [
    {
      id: 'seven-days-thirty-minutes',
      kind: 'personal',
      measure: 'active_days',
      goal: 'each',
      target: 7,
      dailyMinutes: 30,
      days: 7,
      maxParticipants: 1,
    },
    {
      id: 'ten-hours-week',
      kind: 'personal',
      measure: 'focus_minutes',
      goal: 'each',
      target: 600,
      dailyMinutes: 0,
      days: 7,
      maxParticipants: 1,
    },
    {
      id: 'thirty-sessions-month',
      kind: 'personal',
      measure: 'sessions',
      goal: 'each',
      target: 30,
      dailyMinutes: 0,
      days: 30,
      maxParticipants: 1,
    },
    {
      id: 'steady-week-together',
      kind: 'friend',
      measure: 'active_days',
      goal: 'each',
      target: 7,
      dailyMinutes: 15,
      days: 7,
      maxParticipants: 5,
    },
    {
      id: 'ten-hours-each',
      kind: 'friend',
      measure: 'focus_minutes',
      goal: 'each',
      target: 600,
      dailyMinutes: 0,
      days: 14,
      maxParticipants: 5,
    },
    {
      id: 'team-fifty-hours',
      kind: 'group',
      measure: 'focus_minutes',
      goal: 'shared',
      target: 3000,
      dailyMinutes: 0,
      days: 7,
      maxParticipants: 10,
    },
  ],
} as const;

/** Phase 5 leaderboard fair score (configuration version 7, A5.8). */
export const LEADERBOARD_CONFIG_VALUES = {
  'leaderboard.scoreWeights': { consistency: 30, goals: 30, activeDays: 20, focusTime: 20 },
  'leaderboard.dailyFocusCapMinutes': 120,
} as const;

/** Phase 6 notification limits (configuration version 8, A6.1; owner decisions 2026-10-11). */
export const NOTIFICATION_CONFIG_VALUES = {
  'notifications.maxUnrequestedPerDay': 2,
  'notifications.informationalHours': { start: 9, end: 21 },
  'notifications.focusLeaseGraceMinutes': 30,
} as const;

/** Phase 6 live notifications (configuration version 9, A6.3). */
export const LIVE_NOTIFICATION_CONFIG_VALUES = {
  'notifications.eventEndingSoonHours': 48,
} as const;

/** Phase 7 rate limits (configuration version 10, A7.2): project defaults. */
const window = (limit: number, windowSeconds: number) => ({ limit, windowSeconds });
export const RATE_LIMIT_CONFIG_VALUES = {
  'rateLimit.signUp': window(10, 3600),
  'rateLimit.signIn': window(10, 900),
  'rateLimit.refresh': window(120, 3600),
  'rateLimit.deleteAttempts': window(5, 3600),
  'rateLimit.reports': window(20, 86_400),
  'rateLimit.follows': window(200, 3600),
  'rateLimit.reactions': window(300, 3600),
  'rateLimit.invites': window(50, 3600),
  'rateLimit.roomCodes': window(20, 3600),
  'rateLimit.search': window(120, 3600),
  'rateLimit.analytics': window(300, 3600),
} as const;

/** Phase 7 leaderboard integrity flags (configuration version 11, A7.3): project defaults. */
export const INTEGRITY_CONFIG_VALUES = {
  'integrity.lookbackDays': 28,
  'integrity.maxDailyFocusMinutes': 960,
  'integrity.lateSubmissionHours': 72,
  'integrity.spike': { ratio: 5, minMinutes: 600 },
} as const;

/**
 * Tests sign many people up and in from one address, and re-sign everyone when the clock moves:
 * they run with limits nobody reaches. The rate-limit tests set their own.
 */
const UNREACHED_RATE_LIMITS = Object.fromEntries(
  Object.keys(RATE_LIMIT_CONFIG_VALUES).map((key) => [key, window(1_000_000, 60)]),
);

export const CURRENT_CONFIG_VALUES = {
  ...SESSION_CONFIG_VALUES,
  ...TREE_CONFIG_VALUES,
  ...CONSISTENCY_CONFIG_VALUES,
  ...FOREST_CONFIG_VALUES,
  ...CHALLENGE_CONFIG_VALUES,
  ...LEADERBOARD_CONFIG_VALUES,
  ...NOTIFICATION_CONFIG_VALUES,
  ...LIVE_NOTIFICATION_CONFIG_VALUES,
  ...RATE_LIMIT_CONFIG_VALUES,
  ...INTEGRITY_CONFIG_VALUES,
};

/** A complete set of values for a test: the current ones, limits out of reach, some replaced. */
export function configValues(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...CURRENT_CONFIG_VALUES, ...UNREACHED_RATE_LIMITS, ...overrides };
}
