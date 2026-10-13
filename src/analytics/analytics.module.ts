import { Module } from '@nestjs/common';

import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';
import { CheckpointMetricsService } from './checkpoint-metrics.service.js';
import { UsageDataExport } from './usage-data-export.js';

/**
 * Product analytics for the Core Loop Checkpoint: ingest of the app's events (CR.1) and the
 * derived checkpoint metrics (CR.2), read by the admin only. The product imports it only for the
 * person's own data export (A7.1): it never feeds Insights, growth, streaks, or rewards.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, CheckpointMetricsService, UsageDataExport],
  exports: [AnalyticsService, CheckpointMetricsService, UsageDataExport],
})
export class AnalyticsModule {}
