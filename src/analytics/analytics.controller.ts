import { Body, Controller, HttpCode, Post } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import { AnalyticsService } from './analytics.service.js';
import { AnalyticsBatchDto, type AnalyticsBatchResponse } from './dto/analytics-events.dto.js';

/** The signed-in user's own analytics events (CR.1). There is no read route. */
@Controller('me/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Post('events')
  @HttpCode(202)
  ingest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() batch: AnalyticsBatchDto,
  ): Promise<AnalyticsBatchResponse> {
    return this.analytics.ingest(user.userId, batch);
  }
}
