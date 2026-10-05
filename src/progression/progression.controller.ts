import { Body, Controller, Get, Put } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import { AchievementsService } from './achievements.service.js';
import { ShowcaseDto, type AchievementsResponse, type BadgesResponse } from './badge.dto.js';

// Always the signed-in user's own achievements, badges, and showcase.

@Controller('me')
export class ProgressionController {
  constructor(private readonly achievements: AchievementsService) {}

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
}
