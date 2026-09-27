import { parseInstant } from './submission.js';

/** Where the next history page starts: after this session in (startedAt DESC, id DESC) order. */
export interface HistoryPosition {
  startedAt: Date;
  id: string;
}

const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * An opaque, URL-safe cursor: base64url JSON `{ v, s, i }`. Not signed: it only says where a
 * list of the caller's own sessions continues, so tampering can reveal nothing.
 */
export function encodeCursor(position: HistoryPosition): string {
  const payload = { v: VERSION, s: position.startedAt.toISOString(), i: position.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** The position, or null for anything that is not a cursor this server issued. */
export function decodeCursor(cursor: string): HistoryPosition | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const { v, s, i, ...rest } = payload as Record<string, unknown>;
  if (v !== VERSION || Object.keys(rest).length > 0) return null;
  if (typeof s !== 'string' || typeof i !== 'string' || !UUID.test(i)) return null;
  const startedAt = parseInstant(s);
  if (Number.isNaN(startedAt.getTime())) return null;
  return { startedAt, id: i };
}
