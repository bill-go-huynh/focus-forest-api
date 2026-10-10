import {
  canComplete,
  isRoomCode,
  ROOM_COUNTDOWN_MS,
  ROOM_LOBBY_TTL_MS,
  roomPhase,
  startPlan,
} from './room-rules.js';

const MIN = 60_000;
const at = (iso: string) => new Date(iso);

describe('room rules (A5.4)', () => {
  describe('roomPhase', () => {
    const base = {
      status: 'lobby' as const,
      createdAt: at('2026-10-10T10:00:00Z'),
      startsAt: null,
      durationMinutes: 25,
    };

    it('is a lobby until it starts, and expires after the lobby lifetime', () => {
      expect(roomPhase(base, at('2026-10-10T10:30:00Z'), 30)).toBe('lobby');
      expect(roomPhase(base, new Date(base.createdAt.getTime() + ROOM_LOBBY_TTL_MS), 30)).toBe(
        'ended',
      );
    });

    it('counts down, focuses, then ends after the duration plus the pause allowance', () => {
      const room = {
        ...base,
        status: 'in_session' as const,
        startsAt: at('2026-10-10T10:00:10Z'),
      };
      expect(roomPhase(room, at('2026-10-10T10:00:05Z'), 30)).toBe('countdown');
      expect(roomPhase(room, at('2026-10-10T10:00:10Z'), 30)).toBe('focusing');
      expect(roomPhase(room, at('2026-10-10T10:55:09Z'), 30)).toBe('focusing');
      expect(roomPhase(room, at('2026-10-10T10:55:10Z'), 30)).toBe('ended');
    });

    it('is closed when closed', () => {
      expect(roomPhase({ ...base, status: 'closed' }, at('2026-10-10T10:00:00Z'), 30)).toBe(
        'closed',
      );
    });
  });

  describe('startPlan', () => {
    const p = (userId: string, ready: boolean) => ({ userId, ready });

    it('starts automatically when everyone present is ready and there are at least two', () => {
      expect(startPlan([p('a', true), p('b', true)], { byHost: false })).toEqual({
        start: true,
        removed: [],
      });
      expect(startPlan([p('a', true), p('b', false)], { byHost: false })).toEqual({
        start: false,
        removed: [],
      });
      expect(startPlan([p('a', true)], { byHost: false })).toEqual({ start: false, removed: [] });
      // Two ready are not enough while someone present is still not ready.
      expect(startPlan([p('a', true), p('b', true), p('c', false)], { byHost: false })).toEqual({
        start: false,
        removed: [],
      });
    });

    it('lets the host start with the ready ones, the others leaving the room', () => {
      expect(startPlan([p('a', true), p('b', true), p('c', false)], { byHost: true })).toEqual({
        start: true,
        removed: ['c'],
      });
      expect(startPlan([p('a', true), p('b', false)], { byHost: true })).toEqual({
        start: false,
        removed: [],
      });
    });
  });

  describe('canComplete', () => {
    const startsAt = at('2026-10-10T10:00:10Z');
    it('accepts a counted session started near the room start', () => {
      expect(canComplete(startsAt, { startedAt: at('2026-10-10T10:00:10Z'), counted: true })).toBe(
        true,
      );
      expect(
        canComplete(startsAt, { startedAt: new Date(startsAt.getTime() - MIN), counted: true }),
      ).toBe(true);
      expect(
        canComplete(startsAt, {
          startedAt: new Date(startsAt.getTime() + 10 * MIN),
          counted: true,
        }),
      ).toBe(true);
    });

    it('refuses a discarded session or one started elsewhere in time', () => {
      expect(canComplete(startsAt, { startedAt: startsAt, counted: false })).toBe(false);
      expect(
        canComplete(startsAt, { startedAt: new Date(startsAt.getTime() - MIN - 1), counted: true }),
      ).toBe(false);
      expect(
        canComplete(startsAt, {
          startedAt: new Date(startsAt.getTime() + 10 * MIN + 1),
          counted: true,
        }),
      ).toBe(false);
    });
  });

  it('has a short countdown and six-character codes without lookalikes', () => {
    expect(ROOM_COUNTDOWN_MS).toBe(10_000);
    expect(isRoomCode('K7P2QX')).toBe(true);
    for (const code of ['K7P2Q', 'K7P2QXX', 'k7p2qx', 'K7P2Q0', 'K7P2QO', 'K7P2Q1', 'K7P2QI']) {
      expect(isRoomCode(code)).toBe(false);
    }
  });
});
