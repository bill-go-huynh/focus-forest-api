import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import { AchievementsService } from './achievements.service.js';
import {
  EquipDto,
  ShowcaseDto,
  type AchievementsResponse,
  type BadgesResponse,
  type CosmeticsResponse,
  type EquipmentResponse,
} from './badge.dto.js';
import { RewardsService } from './rewards.service.js';

// Always the signed-in user's own achievements, badges, and showcase.

@Controller('me')
export class ProgressionController {
  constructor(
    private readonly achievements: AchievementsService,
    private readonly rewards: RewardsService,
  ) {}

  @Get('achievements')
  list(@CurrentUser() user: AuthenticatedUser): Promise<AchievementsResponse> {
    return this.achievements.achievements(user.userId);
  }

  @Get('badges')
  badges(@CurrentUser() user: AuthenticatedUser): Promise<BadgesResponse> {
    return this.achievements.badges(user.userId);
  }

  /** Replaces the showcase: up to three owned badges, in order. An empty list clears it. */
  @Put('badges/showcase')
  setShowcase(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ShowcaseDto,
  ): Promise<BadgesResponse> {
    return this.achievements.setShowcase(user.userId, body.badgeIds);
  }

  /** Owned cosmetics (system ones included), with whether each is equipped. */
  @Get('cosmetics')
  cosmetics(@CurrentUser() user: AuthenticatedUser): Promise<CosmeticsResponse> {
    return this.rewards.cosmetics(user.userId);
  }

  @Get('equipment')
  equipment(@CurrentUser() user: AuthenticatedUser): Promise<EquipmentResponse> {
    return this.rewards.equipment(user.userId);
  }

  /** Equips an owned cosmetic of the slot's type, replacing the slot's. Idempotent. */
  @Put('equipment/:slot')
  equip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('slot') slot: string,
    @Body() body: EquipDto,
  ): Promise<EquipmentResponse> {
    return this.rewards.equip(user.userId, slot, body.cosmeticId);
  }

  /** Empties the slot. Idempotent. */
  @Delete('equipment/:slot')
  unequip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('slot') slot: string,
  ): Promise<EquipmentResponse> {
    return this.rewards.unequip(user.userId, slot);
  }
}
