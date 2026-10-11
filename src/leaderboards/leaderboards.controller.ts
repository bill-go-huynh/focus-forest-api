import { Controller, Get, Query } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import { LeaderboardQueryDto, type LeaderboardDto } from './leaderboards.dto.js';
import { LeaderboardsService } from './leaderboards.service.js';

/** A5.8 Fair, opt-in leaderboards (spec §16). */
@Controller('leaderboards')
export class LeaderboardsController {
  constructor(private readonly leaderboards: LeaderboardsService) {}

  @Get()
  board(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: LeaderboardQueryDto,
  ): Promise<LeaderboardDto> {
    return this.leaderboards.board(user.userId, {
      scope: query.scope ?? 'friends',
      period: query.period ?? 'weekly',
      ...(query.eventId !== undefined && { eventId: query.eventId }),
    });
  }
}
