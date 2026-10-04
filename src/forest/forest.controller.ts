import { Controller, Get, Param, Put, Query } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import {
  FOREST_DEFAULT_LIMIT,
  ForestQuery,
  MonthParams,
  type ForestPageDto,
  type RecapDto,
  type SeenStateDto,
  type TreeDetailsDto,
} from './forest.dto.js';
import { ForestService } from './forest.service.js';

// Always the signed-in user's own forest.
@Controller('me')
export class ForestController {
  constructor(private readonly forest: ForestService) {}

  /** The forest timeline, newest month first, paginated. */
  @Get('forest')
  page(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ForestQuery,
  ): Promise<ForestPageDto> {
    return this.forest.page(user.userId, {
      cursor: query.cursor,
      limit: query.limit ?? FOREST_DEFAULT_LIMIT,
    });
  }

  /** Tree Details of one month: archived, growing, or resting. */
  @Get('trees/:year/:month')
  details(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MonthParams,
  ): Promise<TreeDetailsDto> {
    return this.forest.details(user.userId, params);
  }

  /** The archived month's recap, as generated at archive. */
  @Get('trees/:year/:month/recap')
  recap(@CurrentUser() user: AuthenticatedUser, @Param() params: MonthParams): Promise<RecapDto> {
    return this.forest.recap(user.userId, params);
  }

  /** The month-end ceremony was shown. Idempotent: the first time is kept. */
  @Put('trees/:year/:month/ceremony-seen')
  ceremonySeen(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MonthParams,
  ): Promise<SeenStateDto> {
    return this.forest.markSeen(user.userId, params, 'ceremonySeenAt');
  }

  /** The recap was viewed. Idempotent: the first time is kept. */
  @Put('trees/:year/:month/recap-seen')
  recapSeen(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MonthParams,
  ): Promise<SeenStateDto> {
    return this.forest.markSeen(user.userId, params, 'recapSeenAt');
  }
}
