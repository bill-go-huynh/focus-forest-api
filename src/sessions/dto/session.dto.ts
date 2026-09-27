import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { canonicalText, codePointLength } from '../../common/text.js';
import type { FocusSessionStatus, TopicStatus } from '../../generated/prisma/client.js';
import { decodeCursor } from '../history-cursor.js';

/** Technical bound on the pause list, against oversized payloads. Not Product configuration. */
export const MAX_PAUSE_INTERVALS = 512;

// Times are checked by the evaluator, which answers 422 `invalid_time` for anything that is
// not an ISO 8601 instant with an explicit offset. Here only the shape is checked (400).
export class PauseIntervalDto {
  @IsString({ message: 'startedAt must be an ISO 8601 time.' })
  startedAt!: string;

  @IsString({ message: 'endedAt must be an ISO 8601 time.' })
  endedAt!: string;
}

/**
 * The body of PUT /me/sessions/:id: only what the client measured. Everything else
 * (focused time, status, attribution, …) is derived by the server, and sending it is a 400.
 */
export class SubmitSessionDto {
  @IsUUID('all', { message: 'topicId must be a UUID.' })
  topicId!: string;

  @IsString({ message: 'startedAt must be an ISO 8601 time.' })
  startedAt!: string;

  @IsString({ message: 'endedAt must be an ISO 8601 time.' })
  endedAt!: string;

  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'plannedMinutes must be a number.' },
  )
  plannedMinutes!: number;

  /** Half-open [startedAt, endedAt), chronological. A pause open at the end is closed at it. */
  @IsArray({ message: 'pauseIntervals must be a list.' })
  @ArrayMaxSize(MAX_PAUSE_INTERVALS, {
    message: `pauseIntervals can hold at most ${MAX_PAUSE_INTERVALS} pauses.`,
  })
  @ValidateNested({ each: true })
  @Type(() => PauseIntervalDto)
  pauseIntervals!: PauseIntervalDto[];
}

/** Technical bound on a note, in Unicode code points after NFC and trimming. */
export const NOTE_MAX_LENGTH = 500;

/**
 * The body of PATCH /me/sessions/:id/note. The note is the only part of a session that can
 * change. `note` is required: clearing is an explicit null (or a blank string), never `{}`.
 */
export class UpdateNoteDto {
  // Trimmed and NFC; a blank note becomes null. Inner spaces and line breaks are kept.
  @Transform(({ value }: { value: unknown }) => {
    const text = canonicalText(value);
    return text === '' ? null : text;
  })
  @ValidateIf((dto: UpdateNoteDto) => dto.note !== null)
  @IsString({ message: 'note must be text, or null to clear it.' })
  @ValidateBy({
    name: 'maxNoteLength',
    validator: {
      validate: (value) => typeof value === 'string' && codePointLength(value) <= NOTE_MAX_LENGTH,
      defaultMessage: () => `note can be at most ${NOTE_MAX_LENGTH} characters.`,
    },
  })
  note!: string | null;
}

/** Technical page bounds for history, not Product configuration. */
export const HISTORY_DEFAULT_LIMIT = 30;
export const HISTORY_MAX_LIMIT = 100;

// `@ValidateIf(... !== undefined)` makes a parameter optional but still validates it when sent.
const isSent =
  (key: string) =>
  (dto: object): boolean =>
    (dto as Record<string, unknown>)[key] !== undefined;

/** The query of GET /me/sessions. No filters in Phase 2; unknown parameters are a 400. */
export class ListSessionsQuery {
  /** Opaque; from the previous page's `nextCursor`. */
  @ValidateIf(isSent('cursor'))
  @ValidateBy({
    name: 'isHistoryCursor',
    validator: {
      validate: (value) => typeof value === 'string' && decodeCursor(value) !== null,
      defaultMessage: () => 'cursor is not valid. Use the nextCursor of a previous page.',
    },
  })
  cursor?: string;

  @ValidateIf(isSent('limit'))
  @Type(() => Number)
  @IsInt({ message: 'limit must be a whole number.' })
  @Min(1, { message: 'limit must be at least 1.' })
  @Max(HISTORY_MAX_LIMIT, { message: `limit can be at most ${HISTORY_MAX_LIMIT}.` })
  limit?: number;
}

/** The topic as it is now: history follows renames and shows archived topics. */
export interface TopicSummary {
  id: string;
  name: string;
  icon: string;
  color: string;
  status: TopicStatus;
}

export interface HistoryItem extends SessionResponse {
  topic: TopicSummary;
}

export interface HistoryPage {
  /** Newest first: startedAt DESC, then id DESC. Grouping by `localDate` is the client's. */
  items: HistoryItem[];
  /** Null when there is nothing older. */
  nextCursor: string | null;
}

export interface SessionResponse {
  id: string;
  topicId: string;
  startedAt: string;
  /** The effective end: completion, the pause limit, or the submitted end. */
  endedAt: string;
  plannedMinutes: number;
  focusedMilliseconds: number;
  pausedMilliseconds: number;
  status: FocusSessionStatus;
  counted: boolean;
  /** "YYYY-MM-DD", the real local date of the start in the month's time zone. */
  localDate: string;
  year: number;
  month: number;
  note: string | null;
  createdAt: string;
}
