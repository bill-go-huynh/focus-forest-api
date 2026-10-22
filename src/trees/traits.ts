/**
 * Milestone traits are earned details on one month's tree, named by stable identifiers
 * ("<kind>:<value>"). The renderer decides what each looks like and ignores identifiers it does
 * not know, so new kinds need no contract change.
 */
export const TRAIT_KINDS = ['monthly-focus-hours', 'streak-days'] as const;

export type TraitKind = (typeof TRAIT_KINDS)[number];

export type ParsedTrait = { kind: TraitKind; value: number } | { kind: 'unknown'; id: string };

/** Earned by focusing this many hours in the month. */
export function focusHourTraitId(hours: number): string {
  return `monthly-focus-hours:${hours}`;
}

/** Earned by reaching a streak milestone (Goals and streaks, A3.2). */
export function streakTraitId(days: number): string {
  return `streak-days:${days}`;
}

export function parseTraitId(id: string): ParsedTrait {
  const match = /^([a-z-]+):(\d+)$/.exec(id);
  const kind = TRAIT_KINDS.find((known) => known === match?.[1]);
  if (!match || !kind) return { kind: 'unknown', id };
  return { kind, value: Number(match[2]) };
}
