import { ArrayMaxSize, ArrayUnique, IsArray, IsString } from 'class-validator';

import type { BadgeCategory, ContentRarity } from './progression-rules.js';

/** A badge as the app shows it. Artwork is bundled in the app, by `artworkId`. */
export interface BadgeDto {
  id: string;
  name: string;
  description: string;
  category: BadgeCategory;
  rarity: ContentRarity;
  artworkId: string;
}

export interface EarnedBadgeDto extends BadgeDto {
  earnedAt: string;
}

export function toBadgeDto(badge: BadgeDto): BadgeDto {
  return {
    id: badge.id,
    name: badge.name,
    description: badge.description,
    category: badge.category,
    rarity: badge.rarity,
    artworkId: badge.artworkId,
  };
}

/** What a submitted session caused (A4.2); null for sessions stored before A4.2. */
export interface SessionProgressionDto {
  newlyEarnedBadges: EarnedBadgeDto[];
}

export interface AchievementDto {
  id: string;
  badge: BadgeDto;
  unit: 'sessions' | 'minutes' | 'days';
  /** Keeps counting above the target once completed. */
  current: number;
  target: number;
  /** Exactly when the badge is owned: permanent. */
  completed: boolean;
  earnedAt: string | null;
  /** Whether the app shows the progress (not for First Session). */
  progressVisible: boolean;
}

export interface AchievementsResponse {
  items: AchievementDto[];
}

export interface BadgesResponse {
  /** Owned badges, in earned order. */
  items: EarnedBadgeDto[];
  /** The pinned badges, in the user's order. */
  showcase: EarnedBadgeDto[];
}

export const SHOWCASE_MAX = 3;

export class ShowcaseDto {
  @IsArray({ message: 'badgeIds must be a list.' })
  @ArrayMaxSize(SHOWCASE_MAX, { message: `badgeIds can hold at most ${SHOWCASE_MAX} badges.` })
  @ArrayUnique({ message: 'badgeIds cannot repeat a badge.' })
  @IsString({ each: true, message: 'badgeIds must be badge ids.' })
  badgeIds!: string[];
}
