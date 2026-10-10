import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module.js';
import {
  AdminReportsController,
  ReportsController,
  WarningsController,
} from './moderation.controller.js';
import { ModerationService } from './moderation.service.js';
import { ReportsService } from './reports.service.js';

/**
 * A5.3 reports and moderation (spec §19.3, docs/09): the user's reports and warnings, and the
 * moderators' queue. Safety tooling ships with Social, never after it.
 */
@Module({
  imports: [AdminModule],
  controllers: [ReportsController, WarningsController, AdminReportsController],
  providers: [ReportsService, ModerationService],
})
export class ModerationModule {}
