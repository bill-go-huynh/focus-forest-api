import type { ContentRarity, Hemisphere } from '../generated/prisma/enums.js';

/**
 * A content pack: seasonal themes and the limited badges they reward, as the owner schedules them. Packs are applied by
 * `npm run content:seed`, never by a migration, so a test database holds no dated content unless
 * a test adds it. Until the admin content tools (Phase 19), a pack is how content goes live.
 *
 * Rewards are badges: every app version draws a badge from its category and rarity, whereas a new
 * cosmetic would equip as nothing until its art ships (docs/10).
 */

export interface PackBadge {
  /** `<content id>:<name>`; the artwork id is the same with `-` for `:`. */
  id: string;
  name: string;
  description: string;
  rarity: ContentRarity;
  source: 'season';
  /** Acquirable from the content's start through a grace after its end. */
  availableFrom: string;
  availableUntil: string;
}

export interface PackTheme {
  id: string;
  name: string;
  description: string;
  environmentId: string;
  /** null: both hemispheres. */
  hemisphere: Hemisphere | null;
  startsAt: string;
  endsAt: string;
  rewards: { id: string; badgeId: string; requiredActiveDays: number }[];
}

export interface ContentPack {
  badges: PackBadge[];
  themes: PackTheme[];
}

/**
 * The seasonal art sets focus-forest-mobile draws (`src/tree/SeasonalOverlay.tsx`); any other id
 * draws nothing, so a pack may not schedule one.
 */
export const KNOWN_SEASONAL_ENVIRONMENTS = [
  'autumn',
  'winter',
  'sakura',
  'rain',
  'night',
  'summer',
] as const;

/** A reward reached at the very end is granted on the next read, so badges outlive their content. */
export const GRACE_DAYS = 7;

const DAY = 86_400_000;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BADGE_ID = /^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$/;

const time = (iso: string) => new Date(iso).getTime();

function duplicates(ids: readonly string[]): string[] {
  return ids.filter((id, i) => ids.indexOf(id) !== i);
}

/** A badge's terms as rewards need them; null windows are open-ended (permanent content). */
export interface BadgeTerms {
  source: string;
  availableFrom: string | null;
  availableUntil: string | null;
}

/** Whether two themes would hold at once for the same people (a both-hemisphere theme overlaps each). */
export function themesOverlap(a: PackTheme, b: PackTheme): boolean {
  const samePeople =
    a.hemisphere === null || b.hemisphere === null || a.hemisphere === b.hemisphere;
  return samePeople && time(a.startsAt) < time(b.endsAt) && time(b.startsAt) < time(a.endsAt);
}

/**
 * Every reason the database or the product would refuse this pack; empty when it is valid.
 * `known` adds badges that already exist (the admin's checks, A6.5); the pack's own come first.
 */
export function contentPackProblems(
  pack: ContentPack,
  known: ReadonlyMap<string, BadgeTerms> = new Map(),
): string[] {
  const problems: string[] = [];
  const badges = new Map<string, BadgeTerms>([
    ...known,
    ...pack.badges.map((b) => [b.id, b] as const),
  ]);

  const ids = (kind: string, list: readonly string[], pattern = SLUG) => {
    for (const id of list)
      if (!pattern.test(id)) problems.push(`${kind} id "${id}" is not a slug.`);
    for (const id of duplicates(list)) problems.push(`${kind} id "${id}" is used twice.`);
  };
  const window = (kind: string, id: string, startsAt: string, endsAt: string) => {
    if (!(time(startsAt) < time(endsAt))) problems.push(`${kind} ${id} ends before it starts.`);
  };
  /** The badge exists, comes from this content, and is acquirable over its window and grace. */
  const reward = (
    badgeId: string,
    source: PackBadge['source'],
    content: { id: string; startsAt: string; endsAt: string },
  ) => {
    const badge = badges.get(badgeId);
    if (!badge) {
      problems.push(`${content.id} rewards the badge ${badgeId}, which does not exist.`);
      return;
    }
    if (badge.source !== source) {
      problems.push(
        `The badge ${badgeId} rewards ${source} content but its source is ${badge.source}.`,
      );
    }
    const from = badge.availableFrom === null ? -Infinity : time(badge.availableFrom);
    const until = badge.availableUntil === null ? Infinity : time(badge.availableUntil);
    if (from > time(content.startsAt) || until < time(content.endsAt) + GRACE_DAYS * DAY) {
      problems.push(
        `The badge ${badgeId} must be acquirable from ${content.id}'s start through a grace of ${GRACE_DAYS} days after its end.`,
      );
    }
  };

  ids(
    'Badge',
    pack.badges.map((badge) => badge.id),
    BADGE_ID,
  );
  for (const badge of pack.badges) {
    window('The badge', badge.id, badge.availableFrom, badge.availableUntil);
  }

  ids(
    'Theme',
    pack.themes.map((theme) => theme.id),
  );
  for (const theme of pack.themes) {
    window('The theme', theme.id, theme.startsAt, theme.endsAt);
    if (!(KNOWN_SEASONAL_ENVIRONMENTS as readonly string[]).includes(theme.environmentId)) {
      problems.push(
        `The theme ${theme.id} uses "${theme.environmentId}", which the app cannot draw.`,
      );
    }
    const days = Math.ceil((time(theme.endsAt) - time(theme.startsAt)) / DAY);
    ids(
      `${theme.id} reward`,
      theme.rewards.map((r) => r.id),
    );
    for (const r of theme.rewards) {
      if (r.requiredActiveDays < 1 || r.requiredActiveDays > days) {
        problems.push(`${theme.id} reward ${r.id} needs between 1 and ${days} active days.`);
      }
      reward(r.badgeId, 'season', theme);
    }
  }

  // One theme at a time for each person: the API shows the first, so a second would never show.
  pack.themes.forEach((theme, i) => {
    for (const other of pack.themes.slice(0, i)) {
      if (themesOverlap(theme, other)) problems.push(`The theme ${theme.id} overlaps ${other.id}.`);
    }
  });

  return problems;
}
