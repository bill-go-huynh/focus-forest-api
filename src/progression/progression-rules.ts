/**
 * Progression content rules (Phase 4 / legacy Phases 8–10; docs/06_DOMAIN_MODEL.md → Progression
 * entities). Content definitions (badges, achievements, species, cosmetics) are versioned seed
 * data in migrations until the admin product exists; user state (ownership) is permanent.
 * Rewards are cosmetic or status only: nothing here reads or changes focus, growth, goals, or
 * streaks. Pure.
 */

/** Defined (and visible in the collection later), acquirable, or no longer acquirable. */
export const CONTENT_STATUSES = ['planned', 'active', 'retired'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/**
 * How content is acquired: `system` (everyone owns it, such as the signature species),
 * `achievement`, `event` (Phase 14), or `season` (Phase 17).
 */
export const CONTENT_SOURCES = ['system', 'achievement', 'event', 'season'] as const;
export type ContentSource = (typeof CONTENT_SOURCES)[number];

/** Sources whose systems exist. Event and season content is defined, never acquired, until then. */
export const ACQUIRABLE_SOURCES: readonly ContentSource[] = ['system', 'achievement'];

export const CONTENT_AVAILABILITIES = ['permanent', 'limited'] as const;
export type ContentAvailability = (typeof CONTENT_AVAILABILITIES)[number];

export const CONTENT_RARITIES = ['common', 'rare', 'legendary'] as const;
export type ContentRarity = (typeof CONTENT_RARITIES)[number];

/** The spec's badge categories (§9.1). */
export const BADGE_CATEGORIES = [
  'focus',
  'consistency',
  'time_based',
  'social',
  'event',
  'rare',
] as const;
export type BadgeCategory = (typeof BADGE_CATEGORIES)[number];

/**
 * Cosmetic types by where they live in the scene (docs/03_TREE_SYSTEM.md §10), not one per
 * example: lanterns, benches, rocks, and flowers are decorations; birds and fireflies fauna.
 * Which decoration it is belongs to its identifier and artwork.
 */
export const COSMETIC_TYPES = [
  'background',
  'decoration',
  'fauna',
  'weather',
  'profile_frame',
  'effect',
] as const;
export type CosmeticType = (typeof COSMETIC_TYPES)[number];

/**
 * What an achievement measures, all derived from Phase 3 truth (no counters): counted sessions,
 * counted focused minutes, and the longest focus streak in days. A closed set: a new criterion
 * is a new value with its evaluator (A4.2), never a free-form rule.
 */
export const ACHIEVEMENT_CRITERIA = [
  'counted_sessions',
  'focused_minutes',
  'longest_streak_days',
  'focus_together_sessions',
  'focus_together_with_friend',
] as const;
export type AchievementCriterion = (typeof ACHIEVEMENT_CRITERIA)[number];

const UNITS: Record<AchievementCriterion, 'sessions' | 'minutes' | 'days'> = {
  counted_sessions: 'sessions',
  focused_minutes: 'minutes',
  longest_streak_days: 'days',
  focus_together_sessions: 'sessions',
  focus_together_with_friend: 'sessions',
};

export function criterionUnit(criterion: AchievementCriterion): 'sessions' | 'minutes' | 'days' {
  return UNITS[criterion];
}

/**
 * A content identifier: a lowercase slug with an optional parameter, like the shipped trait
 * (`streak-days:7`), area (`lake`), and species (`signature`) identifiers. Immutable once
 * shipped, unique within its content type, never a display name.
 */
const CONTENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export function isContentId(id: string): boolean {
  return CONTENT_ID.test(id);
}

/** What decides whether content can be acquired. */
export interface Acquisition {
  status: ContentStatus;
  source: ContentSource;
  availability: ContentAvailability;
  availableFrom: Date | null;
  /** Exclusive. */
  availableUntil: Date | null;
}

export type AcquisitionCheck =
  | { acquirable: true }
  | { acquirable: false; reason: 'not_active' | 'not_started' | 'ended' | 'source_not_available' };

/**
 * Whether content can be acquired at `at`. It decides acquisition only: content already owned
 * stays owned whatever this says later (retired, ended, or re-sourced).
 */
export function acquirableAt(definition: Acquisition, at: Date): AcquisitionCheck {
  if (definition.status !== 'active') return { acquirable: false, reason: 'not_active' };
  if (!ACQUIRABLE_SOURCES.includes(definition.source)) {
    return { acquirable: false, reason: 'source_not_available' };
  }
  if (definition.availableFrom && at < definition.availableFrom) {
    return { acquirable: false, reason: 'not_started' };
  }
  if (definition.availableUntil && at >= definition.availableUntil) {
    return { acquirable: false, reason: 'ended' };
  }
  return { acquirable: true };
}
