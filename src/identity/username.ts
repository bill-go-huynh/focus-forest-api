/**
 * A5.1 usernames: the unique, searchable `@name` people use to find each other (user decision
 * 2026-10-08). Stored lowercase, so uniqueness and search ignore case. Length and characters are
 * technical limits; the database CHECK uses the same pattern.
 */
export const USERNAME_PATTERN = '^[a-z0-9_]{3,20}$';
const USERNAME = new RegExp(USERNAME_PATTERN);

/** Names that could pass for the team or the product. */
const RESERVED = new Set([
  'admin',
  'administrator',
  'moderator',
  'mod',
  'support',
  'help',
  'staff',
  'team',
  'official',
  'system',
  'root',
  'focusforest',
  'focus_forest',
  'forest',
]);

export type UsernameResult =
  { ok: true; username: string } | { ok: false; reason: 'invalid' | 'reserved' };

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export function parseUsername(input: string): UsernameResult {
  const username = normalizeUsername(input);
  if (!USERNAME.test(username)) return { ok: false, reason: 'invalid' };
  if (RESERVED.has(username)) return { ok: false, reason: 'reserved' };
  return { ok: true, username };
}

/** A search prefix: the same characters as a username, 1–20 of them. */
export function parseUsernamePrefix(input: string): string | null {
  const prefix = normalizeUsername(input);
  return /^[a-z0-9_]{1,20}$/.test(prefix) ? prefix : null;
}
