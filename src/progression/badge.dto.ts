import { ArrayMaxSize, ArrayUnique, IsArray, IsString } from 'class-validator';

import type {
  BadgeCategory,
  ContentRarity,
  CosmeticType,
  CriterionUnit,
} from './progression-rules.js';

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

/** A species as the app shows it. Its drawing lives in the app, by `id`. */
export interface SpeciesDto {
  id: string;
  name: string;
  description: string;
  rarity: ContentRarity;
  /** For a rare variant: the species it varies. */
  baseSpeciesId: string | null;
}

export function toSpeciesDto(species: SpeciesDto): SpeciesDto {
  return {
    id: species.id,
    name: species.name,
    description: species.description,
    rarity: species.rarity,
    baseSpeciesId: species.baseSpeciesId,
  };
}

/** A cosmetic as the app shows it. Its artwork is bundled in the app, by `artworkId`. */
export interface CosmeticDto {
  id: string;
  name: string;
  description: string;
  /** Also its equipment slot. */
  type: CosmeticType;
  rarity: ContentRarity;
  artworkId: string;
}

export function toCosmeticDto(cosmetic: CosmeticDto): CosmeticDto {
  return {
    id: cosmetic.id,
    name: cosmetic.name,
    description: cosmetic.description,
    type: cosmetic.type,
    rarity: cosmetic.rarity,
    artworkId: cosmetic.artworkId,
  };
}

/**
 * What an action (a submitted session, an accepted recovery) caused in progression: the badges
 * it earned (A4.2) and the species and cosmetics those badges unlocked (A4.3). Stored with the
 * action and answered unchanged on replays; null for actions stored before A4.2.
 */
export interface SessionProgressionDto {
  newlyEarnedBadges: EarnedBadgeDto[];
  newlyUnlockedSpecies: (SpeciesDto & { unlockedAt: string })[];
  newlyUnlockedCosmetics: (CosmeticDto & { unlockedAt: string })[];
}

export interface SpeciesResponse {
  /** Owned species in catalog order; `selectable` when it can be chosen for a month now. */
  items: (SpeciesDto & { selectable: boolean })[];
  /** The current month's tree: its species, and whether it is frozen (from Sprout on). */
  current: { year: number; month: number; speciesId: string; locked: boolean };
}

export interface CosmeticsResponse {
  /** Owned cosmetics in catalog order. */
  items: (CosmeticDto & { equipped: boolean })[];
}

export interface EquipmentResponse {
  /** The garden: one cosmetic or nothing per scene slot (nothing shows the app's default). */
  forest: Record<'background' | 'decoration' | 'fauna' | 'weather' | 'effect', CosmeticDto | null>;
  /** The profile only: never on trees, the forest, or recaps. */
  profileFrame: CosmeticDto | null;
}

export class EquipDto {
  @IsString({ message: 'cosmeticId must be a cosmetic id.' })
  cosmeticId!: string;
}

export class SelectSpeciesDto {
  @IsString({ message: 'speciesId must be a species id.' })
  speciesId!: string;
}

export interface AchievementDto {
  id: string;
  badge: BadgeDto;
  unit: CriterionUnit;
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
