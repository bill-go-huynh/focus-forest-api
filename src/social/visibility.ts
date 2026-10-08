/**
 * A5.1 privacy policy (spec §19.1–19.2, docs/02 Privacy). Pure: the one place that decides
 * whether a viewer may see a category of someone's content. Every cross-user read goes through
 * `VisibilityService`, which feeds this.
 */
export const PRIVACY_CATEGORIES = [
  'profile',
  'forest',
  'statistics',
  'badges',
  'currentTree',
] as const;
export type PrivacyCategory = (typeof PRIVACY_CATEGORIES)[number];

export const PRIVACY_LEVELS = ['public', 'friends', 'private'] as const;
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

export type PrivacySettingsValues = Record<PrivacyCategory, PrivacyLevel>;

/**
 * The docs/02 recommendation: profile and forest friends only, statistics private. Badges and the
 * current tree follow the profile they appear on. These apply to every user without a stored
 * row, so a change here changes what existing users share: only ever make them stricter.
 */
export const PRIVACY_DEFAULTS: Readonly<PrivacySettingsValues> = Object.freeze({
  profile: 'friends',
  forest: 'friends',
  statistics: 'private',
  badges: 'friends',
  currentTree: 'friends',
});

/** How the viewer stands towards the owner of the content. */
export type Relation = 'self' | 'friend' | 'other' | 'blocked';

export interface RelationFacts {
  self: boolean;
  /** Either user blocks the other. */
  blocked: boolean;
  /** The viewer follows the owner. */
  following: boolean;
  /** The owner follows the viewer. */
  followedBy: boolean;
}

export function relationOf(facts: RelationFacts): Relation {
  if (facts.self) return 'self';
  if (facts.blocked) return 'blocked';
  return facts.following && facts.followedBy ? 'friend' : 'other';
}

export function canSee(level: PrivacyLevel, relation: Relation): boolean {
  switch (relation) {
    case 'self':
      return true;
    case 'blocked':
      return false;
    case 'friend':
      return level !== 'private';
    case 'other':
      return level === 'public';
  }
}
