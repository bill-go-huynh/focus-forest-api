import { Module } from '@nestjs/common';

import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';

/**
 * Product analytics for the Core Loop Checkpoint (CR.1): ingest of the app's events. Imported by
 * nothing in the product: it never feeds Insights, growth, streaks, or rewards.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
