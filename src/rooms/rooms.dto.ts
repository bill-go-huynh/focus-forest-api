import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import type { EarnedBadgeDto } from '../progression/badge.dto.js';
import { ROOM_LIMITS, type RoomPhase } from './room-rules.js';

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const trimmedToNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text === '' ? null : text;
};

/** `POST /rooms` (spec §14.1). */
export class CreateRoomDto {
  @Transform(trimmed)
  @IsString({ message: 'name must be text.' })
  @Length(1, ROOM_LIMITS.nameMax, { message: `name has 1 to ${ROOM_LIMITS.nameMax} characters.` })
  @Matches(/^\P{Cc}*$/u, { message: 'name cannot contain line breaks or control characters.' })
  name!: string;

  /** A label for the room, not a topic of anyone's: each participant focuses on their own. */
  @Transform(trimmedToNull)
  @IsOptional()
  @IsString({ message: 'topic must be text.' })
  @MaxLength(ROOM_LIMITS.topicMax, {
    message: `topic has at most ${ROOM_LIMITS.topicMax} characters.`,
  })
  @Matches(/^\P{Cc}*$/u, { message: 'topic cannot contain line breaks or control characters.' })
  topic?: string | null;

  @IsInt({ message: 'durationMinutes must be a whole number.' })
  @Min(ROOM_LIMITS.durationMin, {
    message: `durationMinutes is at least ${ROOM_LIMITS.durationMin}.`,
  })
  @Max(ROOM_LIMITS.durationMax, {
    message: `durationMinutes is at most ${ROOM_LIMITS.durationMax}.`,
  })
  durationMinutes!: number;

  @IsInt({ message: 'maxParticipants must be a whole number.' })
  @Min(ROOM_LIMITS.participantsMin, {
    message: `maxParticipants is at least ${ROOM_LIMITS.participantsMin}.`,
  })
  @Max(ROOM_LIMITS.participantsMax, {
    message: `maxParticipants is at most ${ROOM_LIMITS.participantsMax}.`,
  })
  maxParticipants!: number;

  @IsIn(['public', 'private'], { message: 'visibility must be public or private.' })
  visibility!: 'public' | 'private';
}

export class JoinRoomDto {
  /** Case is ignored. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString({ message: 'code must be text.' })
  @Length(6, 6, { message: 'code has 6 characters.' })
  code!: string;
}

export class CompleteRoomDto {
  @IsUUID('all', { message: 'sessionId must be a session id.' })
  sessionId!: string;
}

export class CloseRoomDto {
  @Transform(trimmed)
  @IsString({ message: 'Give a reason.' })
  @Length(3, 500, { message: 'Give a reason of 3 to 500 characters.' })
  reason!: string;
}

/**
 * Where a person is in the room. There is no "left" state: someone who leaves simply disappears
 * from the list, so nobody is blamed (docs/02 Focus Together).
 */
export type PlaceState = 'waiting' | 'ready' | 'focusing' | 'completed';

export interface RoomPersonDto {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

/** A room as one viewer sees it. State only: never presentation (docs/07 §6). */
export interface RoomDto {
  id: string;
  /** Only for people in the room: it is how a private room is shared. */
  code: string | null;
  name: string;
  topic: string | null;
  durationMinutes: number;
  maxParticipants: number;
  visibility: 'public' | 'private';
  phase: RoomPhase;
  /** The server-decided synchronized start; each client counts down to it. */
  startsAt: string | null;
  /** `startsAt` plus the duration. */
  endsAt: string | null;
  participants: { user: RoomPersonDto; host: boolean; state: PlaceState }[];
  /** The viewer's own place, or null when they are not in the room. */
  you: { host: boolean; state: PlaceState } | null;
}

export interface RoomCompletionDto {
  room: RoomDto;
  /** What this completion earned, once: a repeat reports nothing. */
  progression: { newlyEarnedBadges: EarnedBadgeDto[] };
}

export interface AdminRoomDto {
  id: string;
  name: string;
  topic: string | null;
  visibility: 'public' | 'private';
  phase: RoomPhase;
  participants: number;
  host: { id: string; email: string; username: string | null } | null;
  createdAt: string;
}
