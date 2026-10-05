import { Type } from 'class-transformer';
import { IsInt, Max, Min, ValidateBy, ValidateIf } from 'class-validator';

import type { EarnedBadgeDto } from '../progression/badge.dto.js';
import type { CurrentTreeResponse } from '../trees/monthly-trees.service.js';
import type { TreeStateDto } from '../trees/tree.contracts.js';
import type {
  ArchivedMonthStatsDto,
  HighlightedNoteDto,
  RecapContent,
} from '../trees/tree-archive.js';
import { decodeForestCursor, type ForestProgression } from './forest-timeline.js';

/** Technical page bounds for the forest, not Product configuration. */
export const FOREST_DEFAULT_LIMIT = 24;
export const FOREST_MAX_LIMIT = 60;

const isSent = (key: string) => (dto: object) =>
  (dto as Record<string, unknown>)[key] !== undefined;

export class ForestQuery {
  /** Opaque; from the previous page's `nextCursor`. */
  @ValidateIf(isSent('cursor'))
  @ValidateBy({
    name: 'isForestCursor',
    validator: {
      validate: (value) => typeof value === 'string' && decodeForestCursor(value) !== null,
      defaultMessage: () => 'cursor is not valid. Use the nextCursor of a previous page.',
    },
  })
  cursor?: string;

  @ValidateIf(isSent('limit'))
  @Type(() => Number)
  @IsInt({ message: 'limit must be a whole number.' })
  @Min(1, { message: 'limit must be at least 1.' })
  @Max(FOREST_MAX_LIMIT, { message: `limit can be at most ${FOREST_MAX_LIMIT}.` })
  limit?: number;
}

export class MonthParams {
  @Type(() => Number)
  @IsInt({ message: 'year must be a whole number.' })
  @Min(2000, { message: 'year must be a four-digit year from 2000.' })
  @Max(9999, { message: 'year must be a four-digit year.' })
  year!: number;

  @Type(() => Number)
  @IsInt({ message: 'month must be a whole number.' })
  @Min(1, { message: 'month must be from 1 to 12.' })
  @Max(12, { message: 'month must be from 1 to 12.' })
  month!: number;
}

/**
 * One month of the forest timeline: a planted (archived) tree, a resting marker for a month
 * without counted focus, or a tree still growing (the current month, or a month in its grace
 * period). Clients ignore kinds they do not know.
 *
 * `focusedMilliseconds` is the month's counted focus for display (not its growth): an archived
 * month's as frozen in its snapshot (whole minutes; a late session never changes it, and it agrees
 * with archived Tree Details), a growing month's so far, and 0 for a resting month.
 */
export type ForestItemDto =
  | {
      kind: 'archived';
      year: number;
      month: number;
      tree: TreeStateDto;
      focusedMilliseconds: number;
    }
  | {
      kind: 'growing';
      year: number;
      month: number;
      tree: TreeStateDto;
      focusedMilliseconds: number;
    }
  | { kind: 'resting'; year: number; month: number; focusedMilliseconds: 0 };

export interface ForestPageDto {
  /** Newest first: the growing edge, then older months. Every month appears once. */
  items: ForestItemDto[];
  nextCursor: string | null;
  /** Cosmetic only. */
  progression: ForestProgression;
  summary: {
    /** Archived trees. */
    treeCount: number;
    /** All counted focus, late sessions included. */
    lifetimeFocusedMinutes: number;
  };
}

export type TreeDetailsDto =
  | {
      kind: 'archived';
      year: number;
      month: number;
      archivedAt: string;
      tree: TreeStateDto;
      stats: ArchivedMonthStatsDto;
      /** Notes highlighted at archive, as they read then (personal data, the owner only). */
      highlightedNotes: HighlightedNoteDto[];
      /** The badges earned this month, as the recap snapshot them at archive (A4.2). */
      badges: EarnedBadgeDto[];
      /** Future-safe: joined events (Phase 11). Empty for now. */
      events: never[];
    }
  | ({ kind: 'growing'; year: number; month: number } & CurrentTreeResponse)
  | { kind: 'resting'; year: number; month: number };

export interface RecapDto extends Omit<RecapContent, 'badges'> {
  /** The recap's badge snapshot, with each badge as the app shows it. */
  badges: EarnedBadgeDto[];
  year: number;
  month: number;
  generatedAt: string;
  tree: TreeStateDto;
  ceremonySeenAt: string | null;
  recapSeenAt: string | null;
}

export interface SeenStateDto {
  ceremonySeenAt: string | null;
  recapSeenAt: string | null;
}

/** The latest archived month, while its month-end ceremony has not been seen. */
export interface PendingCeremonyDto {
  year: number;
  month: number;
}
