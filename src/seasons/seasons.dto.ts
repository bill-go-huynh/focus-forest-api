import { IsIn, ValidateIf } from 'class-validator';

import type { BadgeDto, CosmeticDto } from '../progression/badge.dto.js';
import type { Hemisphere, HemisphereSource } from './hemisphere.js';

/** The user's season: their hemisphere, the theme for it now, and its limited collection. */
export interface SeasonDto {
  hemisphere: Hemisphere;
  hemisphereSource: HemisphereSource;
  /** Environment and atmosphere only; never the tree's earned structure (docs/03 §10). */
  theme: {
    id: string;
    name: string;
    description: string;
    environmentId: string;
    startsAt: string;
    endsAt: string;
  } | null;
  rewards: (
    | {
        id: string;
        kind: 'badge';
        item: BadgeDto;
        requiredActiveDays: number;
        activeDays: number;
        owned: boolean;
      }
    | {
        id: string;
        kind: 'cosmetic';
        item: CosmeticDto;
        requiredActiveDays: number;
        activeDays: number;
        owned: boolean;
      }
  )[];
}

/** Seasonal rewards one call granted. */
export interface SeasonalGrants {
  badgeIds: string[];
  cosmeticIds: string[];
}

export class HemisphereDto {
  /** Null clears the choice: the time zone decides again. */
  @ValidateIf((dto: HemisphereDto) => dto.hemisphere !== null)
  @IsIn(['north', 'south'], { message: 'hemisphere must be north, south, or null.' })
  hemisphere!: Hemisphere | null;
}
