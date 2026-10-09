import { IsUUID } from 'class-validator';

import { MonthParams } from '../forest/forest.dto.js';
import type { ArchivedMonthStatsDto } from '../trees/tree-archive.js';
import type { CosmeticDto, EarnedBadgeDto, EquipmentResponse } from '../progression/badge.dto.js';
import type { TreeStateDto } from '../trees/tree.contracts.js';
import type { UserCardResponse } from '../social/dto/social.dto.js';
import type { ForestProgression } from '../forest/forest-timeline.js';

/**
 * A5.2 `GET /users/:id/profile` (spec §13.2). Each section is null when the owner's privacy hides
 * it from this viewer (the card's `visible` says which), or when there is nothing to show.
 */
export interface VisitedProfileResponse {
  user: UserCardResponse;
  /** `currentTree`: the latest growing tree as stored. */
  currentTree: TreeStateDto | null;
  /** `statistics`: lifetime totals and streaks. Never per topic. */
  statistics: {
    focusedMinutes: number;
    sessionCount: number;
    /** Null without a time zone (no "today" to count from). */
    currentStreak: number | null;
    longestStreak: number;
  } | null;
  /** `badges`: the showcase in the owner's order, and the three most recent badges. */
  badges: { showcase: EarnedBadgeDto[]; recent: EarnedBadgeDto[] } | null;
  /** `forest`: how many trees are planted. */
  forest: { treeCount: number } | null;
  /** With the profile: the equipped profile frame. */
  profileFrame: CosmeticDto | null;
}

/** Visitor stats: the archived month's, without the top topic (topic names stay personal). */
export type VisitedMonthStats = Omit<ArchivedMonthStatsDto, 'topTopic'>;

/**
 * One month of a visited forest. No focus numbers: a visit has the trees as the hero, not a
 * stats comparison (docs/02 Social). A growing tree is null when `currentTree` is hidden.
 */
export type VisitedForestItem =
  | { kind: 'archived'; year: number; month: number; tree: TreeStateDto }
  | { kind: 'growing'; year: number; month: number; tree: TreeStateDto | null }
  | { kind: 'resting'; year: number; month: number };

export interface VisitedForestResponse {
  items: VisitedForestItem[];
  nextCursor: string | null;
  summary: { treeCount: number };
  /** Stored areas only: a visit never unlocks anything. */
  progression: ForestProgression;
  /** The owner's garden, so the visit looks like their forest. */
  equipment: EquipmentResponse['forest'];
}

/** One visited month. Notes are never shown to anyone else (docs/02 Privacy). */
export type VisitedMonthResponse =
  | {
      kind: 'archived';
      year: number;
      month: number;
      archivedAt: string;
      tree: TreeStateDto;
      /** The month's badges as archived, when `badges` is visible. */
      badges: EarnedBadgeDto[] | null;
      /** When `statistics` is visible. */
      stats: VisitedMonthStats | null;
    }
  | { kind: 'growing'; year: number; month: number; tree: TreeStateDto | null }
  | { kind: 'resting'; year: number; month: number };

/** `/users/:userId/forest/:year/:month`: the month's checks, plus the owner's id. */
export class VisitedMonthParams extends MonthParams {
  @IsUUID('all', { message: 'userId must be a user id.' })
  userId!: string;
}
