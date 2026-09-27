import { createHash } from 'node:crypto';

/**
 * Technical storage limits, counted in Unicode characters. They keep rows bounded; they are
 * not product rules and not Product configuration.
 */
export const TOPIC_NAME_MAX_LENGTH = 100;
export const TOPIC_DESCRIPTION_MAX_LENGTH = 500;

/** The curated topic palette (docs/01_DESIGN_SYSTEM.md → Topic colors). */
export const TOPIC_COLORS = Array.from({ length: 12 }, (_, i) => `topic.${i + 1}`);

// A stable content identifier such as "book" or "icon.music-note". The server checks only
// the format: which icons exist and how they render is the client's concern (docs/07 §5).
const ICON_IDENTIFIER = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const ICON_MAX_LENGTH = 64;

export { canonicalText, codePointLength } from '../common/text.js';

export function isTopicColor(value: unknown): value is string {
  return typeof value === 'string' && TOPIC_COLORS.includes(value);
}

export function isTopicIcon(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= ICON_MAX_LENGTH && ICON_IDENTIFIER.test(value)
  );
}

export interface CanonicalTopicFields {
  name: string;
  icon: string;
  color: string;
  description: string | null;
}

/**
 * Identifies the payload a topic was created with, so a replayed create can be told apart
 * from a different create that reuses the id.
 */
export function createFingerprint(fields: CanonicalTopicFields): string {
  const { name, icon, color, description } = fields;
  return createHash('sha256')
    .update(JSON.stringify([name, icon, color, description]))
    .digest('hex');
}
