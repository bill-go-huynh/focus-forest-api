import { boolean, increasingList, integer, shape, type ConfigRegistry } from './config-types.js';

export const PRODUCT_CONFIG_REGISTRY = Symbol('PRODUCT_CONFIG_REGISTRY');

/**
 * Every Product configuration key the backend knows (docs/06_DOMAIN_MODEL.md →
 * Product configuration). Keys are added by the phase that introduces them,
 * together with a migration that creates a new configuration version holding
 * their values.
 */
export const productConfigRegistry = {
  // Phase 2: focus sessions.
  'session.minValidMinutes': {
    description: 'Minimum focused time for a session to count, in minutes',
    type: integer({ min: 1 }),
  },
  'session.maxPauseMinutes': {
    description: 'Total pause after which a session ends automatically, in minutes',
    type: integer({ min: 1 }),
  },

  // Phase 3: the monthly tree (docs/03_TREE_SYSTEM.md). Durations are minutes, rates percent.
  'growth.stageThresholds': {
    description:
      'Cumulative monthly growth, in minutes, for Young Tree, Growing Tree, Mature Tree, Blooming Tree, and Final Form. The first counted session always reaches Sprout',
    type: increasingList(integer({ min: 1 }), { length: 5 }),
  },
  'growth.dailySoftCap': {
    description: 'Focus per local day, in minutes, that counts in full toward growth',
    type: integer({ min: 1 }),
  },
  'growth.overCapRate': {
    description: 'Percent of the focus beyond the daily soft cap that counts toward growth',
    type: integer({ min: 0, max: 100 }),
  },
  'growth.firstMonthProration': {
    description:
      'A partial first month scales its thresholds by days remaining (the join day included) / days in the month, never below floorPercent',
    type: shape({ floorPercent: integer({ min: 1, max: 100 }) }),
  },
  'growth.fullnessWeights': {
    description: 'Percent of fullness from active days and from weekly consistency',
    type: shape(
      {
        activeDays: integer({ min: 0, max: 100 }),
        weeklyConsistency: integer({ min: 0, max: 100 }),
      },
      {
        expected: 'weights adding up to 100',
        holds: (value) => value.activeDays + value.weeklyConsistency === 100,
      },
    ),
  },
  'growth.fullnessTargets': {
    description:
      'Active days in a month for full credit, and active days a week for that week to count as consistent',
    type: shape({
      activeDays: integer({ min: 1, max: 31 }),
      activeDaysPerWeek: integer({ min: 1, max: 7 }),
    }),
  },
  'growth.fullnessLevels': {
    description: 'Fullness score, in percent, at which each fullness level begins',
    type: increasingList(integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 10 }),
  },
  'growth.blossomPoints': {
    description: 'Blossom points for each daily and each weekly goal completed',
    type: shape({ dailyGoal: integer({ min: 1 }), weeklyGoal: integer({ min: 1 }) }),
  },
  'growth.blossomThresholds': {
    description: 'Blossom points at which each blossom level begins',
    type: increasingList(integer({ min: 1 }), { minLength: 1, maxLength: 12 }),
  },
  'growth.richnessTiers': {
    description: 'Growth beyond Final Form, in minutes, at which each richness tier begins',
    type: increasingList(integer({ min: 1 }), { minLength: 1, maxLength: 10 }),
  },
  'growth.focusHourMilestones': {
    description: 'Monthly focused hours that each earn a milestone trait on the tree',
    type: increasingList(integer({ min: 1 }), { minLength: 0, maxLength: 10 }),
  },
  'vitality.rules': {
    description:
      'Thriving needs a run of this many active days ending today; otherwise Healthy within healthyWithinDays without focus, Stable within stableWithinDays, then Quiet. Planned rest days are not counted',
    type: shape(
      {
        thrivingActiveRunDays: integer({ min: 1 }),
        healthyWithinDays: integer({ min: 1 }),
        stableWithinDays: integer({ min: 1 }),
      },
      {
        expected: 'healthyWithinDays below stableWithinDays',
        holds: (value) => value.healthyWithinDays < value.stableWithinDays,
      },
    ),
  },

  // Phase 3: goals, rest days, streaks, and recovery (docs/06_DOMAIN_MODEL.md).
  'goal.dailyDefaultMinutes': {
    description: 'The daily goal, in minutes, until the user sets one',
    type: integer({ min: 1 }),
  },
  'restDay.maxPerWeek': {
    description: 'Rest days a user can plan in one week (Monday to Sunday)',
    type: integer({ min: 0, max: 7 }),
  },
  'restDay.allowSameDay': {
    description: 'Whether today can still be made a rest day',
    type: boolean(),
  },
  'streak.milestones': {
    description: 'Streak lengths, in active days, that are milestones',
    type: increasingList(integer({ min: 1 }), { minLength: 0, maxLength: 20 }),
  },
  'recovery.mechanics': {
    description:
      'The enabled recovery mechanic: a counted session on the day right after one missed day, after a streak of at least minPreviousStreak active days',
    type: shape({ nextDaySession: shape({ minPreviousStreak: integer({ min: 1 }) }) }),
  },
  'recovery.limit': {
    description: 'Recoveries a user can use per calendar month (of the missed day)',
    type: shape({ perMonth: integer({ min: 0 }) }),
  },
  'vitality.goalConsistency': {
    description:
      'Active today and the daily goal met on at least metDaysRequired of the last windowDays local days (today included) is also Thriving',
    type: shape(
      { windowDays: integer({ min: 1 }), metDaysRequired: integer({ min: 1 }) },
      {
        expected: 'metDaysRequired at most windowDays',
        holds: (value) => value.metDaysRequired <= value.windowDays,
      },
    ),
  },
} as const satisfies ConfigRegistry;

export type ProductConfigRegistry = typeof productConfigRegistry;
