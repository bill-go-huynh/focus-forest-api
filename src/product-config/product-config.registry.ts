import { templateProblem, type ChallengeTemplate } from '../challenges/challenge-rules.js';
import { weightsProblem } from '../leaderboards/leaderboard-rules.js';
import {
  boolean,
  increasingList,
  integer,
  list,
  oneOf,
  shape,
  slug,
  type ConfigRegistry,
  type ConfigValueType,
} from './config-types.js';

/** A7.2: a rate limit, `limit` requests in a fixed window of `windowSeconds` (at most a day). */
const rateLimit = shape({
  limit: integer({ min: 1 }),
  windowSeconds: integer({ min: 1, max: 86_400 }),
});

/** A5.5: the challenge templates, coherent as a list (`templateProblem`). */
function challengeTemplates(): ConfigValueType<readonly ChallengeTemplate[]> {
  const items = list(
    shape({
      id: slug(),
      kind: oneOf(['personal', 'friend', 'group']),
      measure: oneOf(['focus_minutes', 'sessions', 'active_days']),
      goal: oneOf(['each', 'shared']),
      target: integer({ min: 1 }),
      dailyMinutes: integer({ min: 0, max: 1440 }),
      days: integer({ min: 1, max: 31 }),
      maxParticipants: integer({ min: 1, max: 10 }),
    }),
  );
  return {
    expected: `${items.expected}, coherent (unique ids; fields that fit the kind and measure)`,
    is: (value): value is readonly ChallengeTemplate[] =>
      items.is(value) && templateProblem(value) === null,
  };
}

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

  // Phase 3: month closure and the Personal Forest (docs/06_DOMAIN_MODEL.md → MonthlyTree, Forest).
  'session.monthGraceMinutes': {
    description:
      'Minutes after a month ends (in its own time zone) before it is archived, so sessions started before the end can still grow its tree',
    type: integer({ min: 0 }),
  },
  'forest.levelThresholds': {
    description: 'Planted (archived) trees at which each forest level after level 1 begins',
    type: increasingList(integer({ min: 1 }), { minLength: 1, maxLength: 20 }),
  },
  'forest.areaLevels': {
    description: 'The forest level that unlocks each cosmetic forest area',
    type: shape({
      lake: integer({ min: 1 }),
      mountains: integer({ min: 1 }),
      night: integer({ min: 1 }),
      seasonal: integer({ min: 1 }),
      decorations: integer({ min: 1 }),
    }),
  },

  // Phase 5 (A5.5): challenges. Cooperative and consistency formats only (docs/02): no races.
  'challenge.templates': {
    description:
      'Challenge templates: who takes part (personal, friend, group), what is measured in the window (focused minutes, counted sessions, or days with at least dailyMinutes), whether every participant must reach the target or everyone adds up to it, the window in local days, and the size',
    type: challengeTemplates(),
  },

  // Phase 5 (A5.8): leaderboards. A fair score, never raw hours alone (spec §16.4).
  'leaderboard.scoreWeights': {
    description:
      'Weights of the leaderboard score: days kept (active, rest, or recovered), days the daily goal was met, active days, and focus time capped per day',
    type: shape(
      {
        consistency: integer({ min: 0, max: 100 }),
        goals: integer({ min: 0, max: 100 }),
        activeDays: integer({ min: 0, max: 100 }),
        focusTime: integer({ min: 0, max: 100 }),
      },
      {
        expected: 'weights where focus time is never the only one above zero',
        holds: (value) => weightsProblem(value) === null,
      },
    ),
  },
  'leaderboard.dailyFocusCapMinutes': {
    description: 'Most focus minutes one day adds to the leaderboard focus-time part',
    type: integer({ min: 15, max: 1440 }),
  },

  // Phase 6 (A6.1): notification delivery (docs/02 Notifications, owner decisions 2026-10-11).
  'notifications.maxUnrequestedPerDay': {
    description:
      'Informational notifications (social, badges, recaps) sent per local day at most; reminders the user set are not counted',
    type: integer({ min: 0, max: 10 }),
  },
  'notifications.informationalHours': {
    description:
      'Local hours [start, end) in which informational notifications are sent; outside them they wait',
    type: shape(
      { start: integer({ min: 0, max: 23 }), end: integer({ min: 1, max: 24 }) },
      { expected: 'start before end', holds: (hours) => hours.start < hours.end },
    ),
  },
  'notifications.focusLeaseGraceMinutes': {
    description:
      'Minutes after a focus lease ends during which notifications still wait, to cover pauses',
    type: integer({ min: 0, max: 240 }),
  },

  // Phase 7 (A7.2): rate limits, each a number of requests in a fixed window of seconds.
  'rateLimit.signUp': {
    description: 'New accounts per address, in a fixed window',
    type: rateLimit,
  },
  'rateLimit.signIn': {
    description: 'Sign-in attempts per address, and per email, in a fixed window',
    type: rateLimit,
  },
  'rateLimit.refresh': {
    description: 'Token refreshes per address, in a fixed window',
    type: rateLimit,
  },
  'rateLimit.deleteAttempts': {
    description:
      'Account deletion attempts per person (each checks the password), in a fixed window',
    type: rateLimit,
  },
  'rateLimit.reports': {
    description: 'Reports a person files, in a fixed window',
    type: rateLimit,
  },
  'rateLimit.follows': {
    description: 'Follows a person makes, in a fixed window',
    type: rateLimit,
  },
  'rateLimit.reactions': {
    description: 'Reactions a person gives, in a fixed window',
    type: rateLimit,
  },
  'rateLimit.invites': {
    description: 'Room and challenge invitations a person sends, in a fixed window',
    type: rateLimit,
  },
  'rateLimit.roomCodes': {
    description: 'Room codes a person tries (private rooms), in a fixed window',
    type: rateLimit,
  },
  'rateLimit.search': {
    description: 'People searches a person makes, in a fixed window',
    type: rateLimit,
  },
  'rateLimit.clientErrors': {
    description: 'Crash and error reports per address (signed in or not), in a fixed window',
    type: rateLimit,
  },
  'rateLimit.analytics': {
    description: 'Analytics batches a person sends, in a fixed window',
    type: rateLimit,
  },

  // Phase 7 (A7.3): leaderboard integrity flags, for staff to look at (never automatic).
  'integrity.lookbackDays': {
    description: 'Days of stored sessions the integrity flags look at',
    type: integer({ min: 7, max: 90 }),
  },
  'integrity.maxDailyFocusMinutes': {
    description: 'Focus in one local day beyond which the day is flagged',
    type: integer({ min: 60, max: 1440 }),
  },
  'integrity.lateSubmissionHours': {
    description: 'Hours after its end beyond which a stored session is flagged as late',
    type: integer({ min: 1, max: 720 }),
  },
  'integrity.spike': {
    description:
      'A week is flagged when its focus reaches minMinutes and ratio times the four weeks before, on average',
    type: shape({
      ratio: integer({ min: 2, max: 50 }),
      minMinutes: integer({ min: 60, max: 10_080 }),
    }),
  },
} as const satisfies ConfigRegistry;

export type ProductConfigRegistry = typeof productConfigRegistry;
