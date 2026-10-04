import { addMonths, monthIndex, type MonthRef } from '../sessions/attribution/calendar.js';

/**
 * The Personal Forest timeline (docs/06_DOMAIN_MODEL.md → Forest): every calendar month from the
 * user's first month to the current one, newest first, so the growing edge comes first and older
 * pages follow. Pure; the service decides what each month shows.
 */

export interface ForestPageMonths {
  /** Newest first. */
  months: MonthRef[];
  /** The last month of this page when older months remain, else null. */
  next: MonthRef | null;
}

/** One page of months in [start, end], continuing after `after` (exclusive) when given. */
export function forestPage(
  start: MonthRef,
  end: MonthRef,
  { limit, after }: { limit: number; after?: MonthRef },
): ForestPageMonths {
  const first = after ? monthIndex(after) - 1 : monthIndex(end);
  const last = monthIndex(start);
  const months: MonthRef[] = [];
  for (let index = first; index >= last && months.length < limit; index -= 1) {
    months.push(addMonths({ year: 0, month: 1 }, index));
  }
  const oldest = months.at(-1);
  const more = oldest !== undefined && monthIndex(oldest) > last;
  return { months, next: more ? (oldest ?? null) : null };
}

const VERSION = 1;

/** An opaque, URL-safe cursor: base64url JSON `{ v, y, m }`, the last month already shown. */
export function encodeForestCursor(month: MonthRef): string {
  const payload = { v: VERSION, y: month.year, m: month.month };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** The month, or null for anything that is not a cursor this server issued. */
export function decodeForestCursor(cursor: string): MonthRef | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const { v, y, m, ...rest } = payload as Record<string, unknown>;
  if (v !== VERSION || Object.keys(rest).length > 0) return null;
  if (!Number.isInteger(y) || !Number.isInteger(m)) return null;
  const year = y as number;
  const month = m as number;
  if (year < 1 || year > 9999 || month < 1 || month > 12) return null;
  return { year, month };
}

/** Cosmetic forest areas (spec §5.3), in display order. Art arrives in later phases. */
export const FOREST_AREAS = ['lake', 'mountains', 'night', 'seasonal', 'decorations'] as const;
export type ForestArea = (typeof FOREST_AREAS)[number];

export interface ForestProgressionRules {
  /** Planted trees at which levels 2, 3, … begin. */
  levelThresholds: readonly number[];
  /** The level that unlocks each area. */
  areaLevels: Readonly<Record<ForestArea, number>>;
}

export interface ForestProgression {
  level: number;
  maxLevel: number;
  /** Archived trees; resting months are not trees. */
  treeCount: number;
  /** Trees needed for the next level, or null at the top level. */
  nextLevelAt: number | null;
  /** Never shrinks. May hold an area this version no longer knows. */
  unlockedAreas: string[];
}

/**
 * Forest level and unlocked areas from planted trees. The level follows the active thresholds;
 * areas only accumulate: `unlocked` (already stored) are kept whatever the thresholds are now,
 * and the areas the level reaches are added. Known areas come in display order, then any others.
 * Cosmetic: nothing else reads it.
 */
export function forestProgression(
  treeCount: number,
  rules: ForestProgressionRules,
  unlocked: readonly string[] = [],
): ForestProgression {
  const reached = rules.levelThresholds.filter((threshold) => threshold <= treeCount).length;
  const level = 1 + reached;
  const kept = new Set([...unlocked, ...eligibleAreas(level, rules)]);
  const known: string[] = FOREST_AREAS.filter((area) => kept.has(area));
  const others = [...kept].filter((area) => !known.includes(area)).sort();
  return {
    level,
    maxLevel: 1 + rules.levelThresholds.length,
    treeCount,
    nextLevelAt: rules.levelThresholds[reached] ?? null,
    unlockedAreas: [...known, ...others],
  };
}

/** The areas a forest level reaches. */
export function eligibleAreas(level: number, rules: ForestProgressionRules): ForestArea[] {
  return FOREST_AREAS.filter((area) => rules.areaLevels[area] <= level);
}
