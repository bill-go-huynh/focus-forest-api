/** Where a social list continues: after this row in (createdAt DESC, userId DESC) order. */
export interface SocialPosition {
  createdAt: Date;
  userId: string;
}

const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Opaque base64url JSON `{ v, t, u }`. Unsigned: it only positions a list of the caller's own. */
export function encodeSocialCursor(position: SocialPosition): string {
  const payload = { v: VERSION, t: position.createdAt.toISOString(), u: position.userId };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** The position, or null for anything that is not a cursor this server issued. */
export function decodeSocialCursor(cursor: string): SocialPosition | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const { v, t, u, ...rest } = payload as Record<string, unknown>;
  if (v !== VERSION || Object.keys(rest).length > 0) return null;
  if (typeof t !== 'string' || typeof u !== 'string' || !UUID.test(u)) return null;
  const createdAt = new Date(t);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== t) return null;
  return { createdAt, userId: u };
}
