import { Controller, Get, Query } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import {
  HeatmapQuery,
  MonthQuery,
  WeekQuery,
  type HeatmapDto,
  type LifetimeStatsDto,
  type MonthInsightsDto,
  type RecordsDto,
  type WeekInsightsDto,
} from './insights.dto.js';
import { InsightsService } from './insights.service.js';

// Always the signed-in user's own numbers.
@Controller('me')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  /** One Monday-to-Sunday week; the current one by default. */
  @Get('insights/week')
  week(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: WeekQuery,
  ): Promise<WeekInsightsDto> {
    return this.insights.week(user.userId, query.weekStart);
  }

  /** One calendar month; the current one by default. */
  @Get('insights/month')
  month(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MonthQuery,
  ): Promise<MonthInsightsDto> {
    return this.insights.month(user.userId, query);
  }

  /** Day cells for a date range (at most a year and a week); the last 365 days by default. */
  @Get('insights/heatmap')
  heatmap(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: HeatmapQuery,
  ): Promise<HeatmapDto> {
    return this.insights.heatmap(user.userId, query);
  }

  /** Personal records as of today. */
  @Get('insights/records')
  records(@CurrentUser() user: AuthenticatedUser): Promise<RecordsDto> {
    return this.insights.records(user.userId);
  }

  /** Lifetime stats for the profile. */
  @Get('profile/stats')
  lifetime(@CurrentUser() user: AuthenticatedUser): Promise<LifetimeStatsDto> {
    return this.insights.lifetime(user.userId);
  }
}
