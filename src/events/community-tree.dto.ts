import { ArrayMaxSize, IsArray, IsIn } from 'class-validator';

import type { BadgeDto, CosmeticDto } from '../progression/badge.dto.js';

/** A5.7 Community Tree stages, in growing order (spec §12). */
export const COMMUNITY_STAGES = ['seedling', 'growing_tree', 'bloom', 'final_form'] as const;
export type CommunityStage = (typeof COMMUNITY_STAGES)[number];

/**
 * The shared tree as anyone who can see its event sees it. A warm shared number, never a race:
 * no answer lists, ranks, or compares the people who grew it (docs/01, docs/02).
 */
export interface CommunityTreeDto {
  eventId: string;
  name: string;
  artworkId: string;
  /** The highest stage reached; null before the first. */
  stage: CommunityStage | null;
  totalMinutes: number;
  participants: number;
  joined: boolean;
  /** The viewer's own minutes, shown only to them; null until joined. */
  yourMinutes: number | null;
  milestones: {
    stage: CommunityStage;
    thresholdMinutes: number;
    reached: boolean;
    reachedAt: string | null;
    rewards: { badge: BadgeDto | null; cosmetic: CosmeticDto | null };
  }[];
  /** Shared rewards received and not yet celebrated (docs/04: once, on the next open). */
  celebrate: CommunityStage[];
}

/** The Community Tree line on an event. */
export interface CommunityTreeSummary {
  stage: CommunityStage | null;
  totalMinutes: number;
}

/** What one session added to its event's Community Tree. */
export interface SessionCommunityResult {
  minutes: number;
  totalMinutes: number;
  /** The milestones this contribution reached. */
  reachedStages: CommunityStage[];
}

export class CelebratedDto {
  @IsArray({ message: 'stages must be a list of Community Tree stages.' })
  @ArrayMaxSize(COMMUNITY_STAGES.length)
  @IsIn(COMMUNITY_STAGES, {
    each: true,
    message: 'stages must be a list of Community Tree stages.',
  })
  stages!: CommunityStage[];
}
