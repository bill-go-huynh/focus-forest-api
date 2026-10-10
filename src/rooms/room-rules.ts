/**
 * A5.4 Focus Together rules (spec §14, docs/02 Focus Together). Pure. The values here are
 * technical bounds, not Product configuration: they shape the room mechanics, not focus or growth.
 */

/** The shared countdown between the start decision and the synchronized start. */
export const ROOM_COUNTDOWN_MS = 10_000;
/** A lobby nobody starts ends on its own. */
export const ROOM_LOBBY_TTL_MS = 2 * 60 * 60_000;
/** A completed session counts for the room when it started this close to the room's start. */
export const COMPLETION_EARLY_MS = 60_000;
export const COMPLETION_LATE_MS = 10 * 60_000;

export const ROOM_LIMITS = {
  nameMax: 50,
  topicMax: 50,
  durationMin: 5,
  durationMax: 180,
  participantsMin: 2,
  participantsMax: 10,
} as const;

/** Six characters without lookalikes (no 0, O, 1, I). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;

export function isRoomCode(code: string): boolean {
  return ROOM_CODE.test(code);
}

export type StoredRoomStatus = 'lobby' | 'in_session' | 'closed';
/** What the room is now: stored status plus the clock. */
export type RoomPhase = 'lobby' | 'countdown' | 'focusing' | 'ended' | 'closed';

export interface RoomTiming {
  status: StoredRoomStatus;
  createdAt: Date;
  startsAt: Date | null;
  durationMinutes: number;
}

/**
 * A started room focuses from `startsAt` for its duration, and ends once the duration plus the
 * pause allowance (`session.maxPauseMinutes`) has passed, so a participant who paused can still
 * finish inside it.
 */
export function roomPhase(room: RoomTiming, now: Date, maxPauseMinutes: number): RoomPhase {
  if (room.status === 'closed') return 'closed';
  if (room.status === 'lobby' || !room.startsAt) {
    return now.getTime() - room.createdAt.getTime() >= ROOM_LOBBY_TTL_MS ? 'ended' : 'lobby';
  }
  const start = room.startsAt.getTime();
  if (now.getTime() < start) return 'countdown';
  const end = start + (room.durationMinutes + maxPauseMinutes) * 60_000;
  return now.getTime() >= end ? 'ended' : 'focusing';
}

/** Whether a room still holds its people: a person can be in one active room at a time. */
export function isActive(phase: RoomPhase): boolean {
  return phase === 'lobby' || phase === 'countdown' || phase === 'focusing';
}

export interface LobbyPlace {
  userId: string;
  ready: boolean;
}

/**
 * When a lobby starts: on its own once everyone present is ready and there are at least two; or by
 * the host with the ready ones (at least two), the others leaving the room quietly.
 */
export function startPlan(
  places: readonly LobbyPlace[],
  options: { byHost: boolean },
): { start: boolean; removed: string[] } {
  const ready = places.filter((place) => place.ready);
  if (ready.length < ROOM_LIMITS.participantsMin) return { start: false, removed: [] };
  if (!options.byHost && ready.length !== places.length) return { start: false, removed: [] };
  return {
    start: true,
    removed: places.filter((place) => !place.ready).map((place) => place.userId),
  };
}

/** A participant's own session completes their place in the room: counted, started with it. */
export function canComplete(
  startsAt: Date,
  session: { startedAt: Date; counted: boolean },
): boolean {
  if (!session.counted) return false;
  const offset = session.startedAt.getTime() - startsAt.getTime();
  return offset >= -COMPLETION_EARLY_MS && offset <= COMPLETION_LATE_MS;
}
