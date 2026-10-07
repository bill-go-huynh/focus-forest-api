import {
  acquirableAt,
  criterionUnit,
  type AchievementCriterion,
  type Acquisition,
  type ContentSource,
  type ContentStatus,
} from './progression-rules.js';

/**
 * The Collection Book (A4.4; docs/06_DOMAIN_MODEL.md → CollectionBook): a derived view of the
 * species, badges, and cosmetics the user owns or can still obtain, never stored. Owned items
 * stay forever; an unowned item appears only when it can really be obtained now. Hints are
 * structured truth (the achievement's badge, unit, target, progress), never marketing copy or
 * criterion names. No percentage. Pure.
 */

export interface CollectionDefinition extends Acquisition {
  id: string;
  sortOrder: number;
}

/**
 * Whether an item belongs in the user's collection: owned (whatever its status or window now),
 * or acquirable now and `reachable` (its achievement can be earned). Planned, retired, ended,
 * not-yet-open, and event or season content the user does not own stays out of sight.
 */
export function isVisible(
  definition: CollectionDefinition,
  user: { owned: boolean; reachable: boolean },
  now: Date,
): boolean {
  if (user.owned) return true;
  return user.reachable && acquirableAt(definition, now).acquirable;
}

export interface CollectionAvailability {
  status: ContentStatus;
  limited: boolean;
  availableFrom: string | null;
  availableUntil: string | null;
  /** Whether it could be obtained now (a fact, never urgency). */
  obtainableNow: boolean;
}

export function availabilityOf(definition: Acquisition, now: Date): CollectionAvailability {
  return {
    status: definition.status,
    limited: definition.availability === 'limited',
    availableFrom: definition.availableFrom?.toISOString() ?? null,
    availableUntil: definition.availableUntil?.toISOString() ?? null,
    obtainableNow: acquirableAt(definition, now).acquirable,
  };
}

/** How a locked item is obtained. Event and season hints gain detail with their phases. */
export type UnlockHint =
  | {
      type: 'achievement';
      achievementId: string;
      /** The achievement's badge name and description (its user-facing copy). */
      name: string;
      description: string;
      unit: 'sessions' | 'minutes' | 'days';
      target: number;
      /** Null when the achievement does not show progress. */
      current: number | null;
    }
  | { type: 'event' }
  | { type: 'season' };

export interface HintAchievement {
  id: string;
  criterion: AchievementCriterion;
  target: number;
  progressVisible: boolean;
  badge: { name: string; description: string };
}

export function unlockOf(
  definition: { source: ContentSource },
  achievement: { achievement: HintAchievement; value: number } | null,
): UnlockHint | null {
  switch (definition.source) {
    case 'system':
      return null;
    case 'achievement': {
      if (!achievement) return null;
      const { achievement: a, value } = achievement;
      return {
        type: 'achievement',
        achievementId: a.id,
        name: a.badge.name,
        description: a.badge.description,
        unit: criterionUnit(a.criterion),
        target: a.target,
        current: a.progressVisible ? value : null,
      };
    }
    case 'event':
      return { type: 'event' };
    case 'season':
      return { type: 'season' };
    default: {
      const unknown: never = definition.source;
      throw new Error(`No unlock hint for source ${String(unknown)}.`);
    }
  }
}

/** Catalog order, then id: ownership never moves an item. */
export function byCatalogOrder(
  a: { id: string; sortOrder: number },
  b: { id: string; sortOrder: number },
): number {
  return a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function summarize(items: readonly { owned: boolean }[]): { owned: number; total: number } {
  return { owned: items.filter((item) => item.owned).length, total: items.length };
}
