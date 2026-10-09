import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';

import { FOREST_DEFAULT_LIMIT, ForestQuery } from '../forest/forest.dto.js';
import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import { ReactionTargetQuery, type ReactionSummaryResponse } from '../social/dto/social.dto.js';
import {
  VisitedMonthParams,
  type VisitedForestResponse,
  type VisitedMonthResponse,
  type VisitedProfileResponse,
} from './visits.dto.js';
import { VisitsService } from './visits.service.js';

const userId = new ParseUUIDPipe();

/** Another user's profile, forest, and months, through their privacy settings (A5.2). */
@Controller('users/:userId')
export class VisitsController {
  constructor(private readonly visits: VisitsService) {}

  @Get('profile')
  profile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', userId) ownerId: string,
  ): Promise<VisitedProfileResponse> {
    return this.visits.profile(user.userId, ownerId);
  }

  @Get('forest')
  forest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', userId) ownerId: string,
    @Query() query: ForestQuery,
  ): Promise<VisitedForestResponse> {
    return this.visits.forest(user.userId, ownerId, {
      cursor: query.cursor,
      limit: query.limit ?? FOREST_DEFAULT_LIMIT,
    });
  }

  @Get('forest/:year/:month')
  month(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: VisitedMonthParams,
  ): Promise<VisitedMonthResponse> {
    return this.visits.month(user.userId, params.userId, {
      year: params.year,
      month: params.month,
    });
  }

  @Get('reactions')
  reactions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', userId) ownerId: string,
    @Query() query: ReactionTargetQuery,
  ): Promise<ReactionSummaryResponse> {
    return this.visits.reactionSummary(user.userId, ownerId, query.target);
  }

  @Put('reactions/:reaction')
  @HttpCode(200)
  react(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', userId) ownerId: string,
    @Param('reaction') reaction: string,
    @Query() query: ReactionTargetQuery,
  ): Promise<ReactionSummaryResponse> {
    return this.visits.react(user.userId, ownerId, reaction, query.target);
  }

  @Delete('reactions/:reaction')
  @HttpCode(200)
  unreact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', userId) ownerId: string,
    @Param('reaction') reaction: string,
    @Query() query: ReactionTargetQuery,
  ): Promise<ReactionSummaryResponse> {
    return this.visits.unreact(user.userId, ownerId, reaction, query.target);
  }
}
