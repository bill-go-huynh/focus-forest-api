import { decodeCursor, encodeCursor } from './history-cursor.js';

const id = '0192f1a2-3b4c-7d5e-8f60-718293a4b5c6';
const startedAt = new Date('2026-09-27T10:00:00.123Z');
const encodeRaw = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('history cursor', () => {
  it('round-trips the start time and id, to the millisecond', () => {
    expect(decodeCursor(encodeCursor({ startedAt, id }))).toEqual({ startedAt, id });
  });

  it('is URL-safe', () => {
    expect(encodeCursor({ startedAt, id })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'not base64url!'],
    ['not JSON', Buffer.from('hello').toString('base64url')],
    ['a JSON list', encodeRaw([1, 2])],
    ['JSON null', encodeRaw(null)],
    ['an unknown version', encodeRaw({ v: 2, s: startedAt.toISOString(), i: id })],
    ['no version', encodeRaw({ s: startedAt.toISOString(), i: id })],
    ['no start', encodeRaw({ v: 1, i: id })],
    ['an invalid start', encodeRaw({ v: 1, s: 'yesterday', i: id })],
    ['a start without offset', encodeRaw({ v: 1, s: '2026-09-27T10:00:00', i: id })],
    ['a numeric start', encodeRaw({ v: 1, s: 1_790_000_000_000, i: id })],
    ['no id', encodeRaw({ v: 1, s: startedAt.toISOString() })],
    ['an id that is not a UUID', encodeRaw({ v: 1, s: startedAt.toISOString(), i: 'abc' })],
    ['an extra field', encodeRaw({ v: 1, s: startedAt.toISOString(), i: id, x: 1 })],
  ])('rejects %s', (_case, cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });
});
