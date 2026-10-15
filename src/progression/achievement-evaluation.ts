import { longestStreak, type ActivityHistory } from '../consistency/streak.js';
import { addDays, type LocalDate } from '../common/local-date.js';
import {
  ACHIEVEMENT_CRITERIA,
  acquirableAt,
  criterionUnit,
  isContentId,
  type AchievementCriterion,
  type Acquisition,
  type CriterionUnit,
  type BadgeCategory,
  type ContentRarity,
} from './progression-rules.js';

/**
 * Achievement evaluation (A4.2; docs/06_DOMAIN_MODEL.md → Achievement): one evaluator per
 * criterion, each reading Core truth (no counters): counted sessions, whole counted focused
 * minutes, and the longest streak in days (the streak domain's own number, so a broken streak
 * keeps its record and rest bridges without adding a day). Ownership, not the value, makes an
 * achievement complete. Pure.
 */

export type AchievementValues = Record<AchievementCriterion, number>;

/** What the criteria are derived from. */
export interface AchievementInput {
  lifetime: { sessionCount: number; focusedMilliseconds: number };
  history: ActivityHistory;
  /**
   * A5.4: completed Focus Together sessions (a participant's own counted session, linked to a
   * room they started with), and those in a room where a friend focused too.
   */
  together: { sessions: number; withFriend: number };
  /**
   * Owner decision 2026-10-15: counted sessions started before 07:00 and at or after 22:00, in
   * the local time of their month's time zone (the session's own attribution).
   */
  timeOfDay: { early: number; late: number };
  /** Owner decision 2026-10-15: counted sessions that added minutes to a Community Tree. */
  community: { contributions: number };
}

/**
 * Categories whose criteria exist. Social is evaluated from A5.4 (Focus Together), time-based from
 * the owner decision of 2026-10-15; event badges come from event milestones, and special badges
 * are never evaluated, even if activated. A category, never a rarity: category "rare" and rarity
 * "rare" are unrelated.
 */
export const EVALUATED_CATEGORIES: readonly BadgeCategory[] = [
  'focus',
  'consistency',
  'time_based',
  'social',
];

export interface AchievementBadge extends Acquisition {
  id: string;
  category: BadgeCategory;
  rarity: ContentRarity;
  sortOrder: number;
}

export interface EarnableAchievement {
  id: string;
  badgeId: string;
  criterion: AchievementCriterion;
  target: number;
  progressVisible: boolean;
  badge: AchievementBadge;
}

/** Achievements whose badge can be earned now, in catalog order. */
export function earnableAchievements<T extends EarnableAchievement>(
  definitions: readonly T[],
  now: Date,
): T[] {
  return definitions
    .filter(
      (definition) =>
        ACHIEVEMENT_CRITERIA.includes(definition.criterion) &&
        EVALUATED_CATEGORIES.includes(definition.badge.category) &&
        acquirableAt(definition.badge, now).acquirable,
    )
    .sort(byCatalogOrder);
}

export function byCatalogOrder(a: EarnableAchievement, b: EarnableAchievement): number {
  return a.badge.sortOrder - b.badge.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function achievementValues(input: AchievementInput): AchievementValues {
  return {
    counted_sessions: input.lifetime.sessionCount,
    focused_minutes: Math.floor(input.lifetime.focusedMilliseconds / 60_000),
    longest_streak_days: longestStreak(input.history),
    focus_together_sessions: input.together.sessions,
    focus_together_with_friend: input.together.withFriend,
    sessions_before_7: input.timeOfDay.early,
    sessions_after_22: input.timeOfDay.late,
    full_weekends: fullWeekends(input.history.activeDates),
    community_contributions: input.community.contributions,
  };
}

/** Weekends with counted focus on both the Saturday and the Sunday (any weekends, in any order). */
export function fullWeekends(activeDates: readonly LocalDate[]): number {
  const active = new Set(activeDates);
  return [...active].filter((date) => isSaturday(date) && active.has(addDays(date, 1))).length;
}

function isSaturday(date: LocalDate): boolean {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 6;
}

/** A counted session to take out of the input: what the values were just before it. */
export interface RemovedSession {
  focusedMilliseconds: number;
  localDate: LocalDate;
  /** Counted sessions on its local date, itself included. */
  countedOnSameDay: number;
  startedBefore7: boolean;
  startedAfter22: boolean;
  contributedToCommunity: boolean;
}

export function withoutSession(input: AchievementInput, session: RemovedSession): AchievementInput {
  const aloneOnItsDay = session.countedOnSameDay <= 1;
  return {
    ...input,
    lifetime: {
      sessionCount: input.lifetime.sessionCount - 1,
      focusedMilliseconds: input.lifetime.focusedMilliseconds - session.focusedMilliseconds,
    },
    history: {
      ...input.history,
      activeDates: aloneOnItsDay
        ? input.history.activeDates.filter((date) => date !== session.localDate)
        : input.history.activeDates,
    },
    timeOfDay: {
      early: input.timeOfDay.early - (session.startedBefore7 ? 1 : 0),
      late: input.timeOfDay.late - (session.startedAfter22 ? 1 : 0),
    },
    community: {
      contributions: input.community.contributions - (session.contributedToCommunity ? 1 : 0),
    },
  };
}

/**
 * The input just before a streak recovery of `missedDate` (A4.2.G): the same focus and sessions,
 * without that recovered day. What the recovery crossed is what it caused.
 */
export function withoutRecovery(input: AchievementInput, missedDate: LocalDate): AchievementInput {
  return {
    ...input,
    history: {
      ...input.history,
      recoveredDates: input.history.recoveredDates.filter((date) => date !== missedDate),
    },
  };
}

export function isReached(value: number, target: number): boolean {
  return value >= target;
}

export interface AchievementProgress {
  unit: CriterionUnit;
  /** Keeps counting above the target. */
  current: number;
  target: number;
  completed: boolean;
  earnedAt: string | null;
}

/** Progress toward an achievement: completed exactly when its badge is owned. */
export function progressOf(
  definition: Pick<EarnableAchievement, 'criterion' | 'target'>,
  value: number,
  earnedAt: Date | null,
): AchievementProgress {
  return {
    unit: criterionUnit(definition.criterion),
    current: value,
    target: definition.target,
    completed: earnedAt !== null,
    earnedAt: earnedAt?.toISOString() ?? null,
  };
}

export interface PlannedGrant {
  badgeId: string;
  earnedAt: Date;
  /** The action being evaluated (a session or a recovery) crossed the threshold. */
  causedByAction: boolean;
}

const SESSION_CRITERIA: readonly AchievementCriterion[] = ['counted_sessions', 'focused_minutes'];

/**
 * The grants for achievements not yet owned that are reached now. `before` is the values without
 * the session being evaluated (null outside a submission): what it crossed is caused by it and
 * earned now. What was reached before (history from before A4.2) is dated at the stored session
 * that crossed it when the criterion is a session total (`crossings`, by achievement id); a
 * streak cannot be replayed as it stood then, so it is dated now. Never later than now, never
 * before the badge opened.
 */
export function planGrants(
  pending: readonly EarnableAchievement[],
  values: { after: AchievementValues; before: AchievementValues | null },
  now: Date,
  crossings: ReadonlyMap<string, Date>,
): PlannedGrant[] {
  return pending
    .filter((achievement) => isReached(values.after[achievement.criterion], achievement.target))
    .map((achievement) => {
      const caused =
        values.before !== null &&
        !isReached(values.before[achievement.criterion], achievement.target);
      const crossed = SESSION_CRITERIA.includes(achievement.criterion)
        ? crossings.get(achievement.id)
        : undefined;
      let earnedAt = caused || !crossed ? now : crossed;
      if (earnedAt > now) earnedAt = now;
      const opened = achievement.badge.availableFrom;
      if (opened && earnedAt < opened) earnedAt = opened;
      return { badgeId: achievement.badgeId, earnedAt, causedByAction: caused };
    });
}

/**
 * Stored with the action (focus_sessions and streak_recoveries .progression_result): the badges
 * it caused and the rewards those badges unlocked (A4.3), as ids. A result stored before A4.3
 * has no reward lists: it unlocked none.
 */
export interface ProgressionResult {
  newlyEarnedBadgeIds: string[];
  newlyUnlockedSpeciesIds: string[];
  newlyUnlockedCosmeticIds: string[];
}

const RESULT_LISTS = [
  'newlyEarnedBadgeIds',
  'newlyUnlockedSpeciesIds',
  'newlyUnlockedCosmeticIds',
] as const;

export function parseProgressionResult(value: unknown): ProgressionResult {
  const fail = (why: string): never => {
    throw new Error(`Invalid progression result: ${why}.`);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('not an object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !RESULT_LISTS.some((list) => list === key))) {
    fail('unexpected fields');
  }
  if (!('newlyEarnedBadgeIds' in record)) fail('no badge ids');
  const read = (key: (typeof RESULT_LISTS)[number]): string[] => {
    const ids = record[key] ?? [];
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && isContentId(id))) {
      return fail(`bad ${key}`);
    }
    if (new Set(ids).size !== ids.length) fail(`duplicate ${key}`);
    return [...(ids as string[])];
  };
  return {
    newlyEarnedBadgeIds: read('newlyEarnedBadgeIds'),
    newlyUnlockedSpeciesIds: read('newlyUnlockedSpeciesIds'),
    newlyUnlockedCosmeticIds: read('newlyUnlockedCosmeticIds'),
  };
}
