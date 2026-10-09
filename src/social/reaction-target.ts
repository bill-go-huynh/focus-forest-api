import { isContentId } from '../progression/progression-rules.js';

/** The spec §13.4 reactions as stable ids (🔥 🌱 👏 ❤️ ✨); the app draws them. */
export const REACTIONS = ['fire', 'sprout', 'clap', 'heart', 'sparkles'] as const;
export type ReactionKindId = (typeof REACTIONS)[number];

/**
 * What a reaction is on, written `forest`, `tree:YYYY-MM`, or `badge:<badge id>` in the API.
 * `key` is what the database stores next to the type.
 */
export type ReactionTarget =
  | { type: 'forest'; key: '' }
  | { type: 'tree'; key: string; year: number; month: number }
  | { type: 'badge'; key: string; badgeId: string };

const TREE = /^tree:([0-9]{4})-(0[1-9]|1[0-2])$/;
const BADGE_ID_MAX = 100;

/** The target, or null for anything else. Years before 2000 are refused, like months elsewhere. */
export function parseReactionTarget(input: string): ReactionTarget | null {
  if (input === 'forest') return { type: 'forest', key: '' };
  const tree = TREE.exec(input);
  if (tree) {
    const year = Number(tree[1]);
    if (year < 2000) return null;
    return { type: 'tree', key: input.slice('tree:'.length), year, month: Number(tree[2]) };
  }
  if (input.startsWith('badge:')) {
    const badgeId = input.slice('badge:'.length);
    if (badgeId.length > BADGE_ID_MAX || !isContentId(badgeId)) return null;
    return { type: 'badge', key: badgeId, badgeId };
  }
  return null;
}

export function formatReactionTarget(target: { type: string; key: string }): string {
  return target.type === 'forest' ? 'forest' : `${target.type}:${target.key}`;
}
