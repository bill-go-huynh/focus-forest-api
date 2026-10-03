import { Module } from '@nestjs/common';

import { FocusStatsService } from '../focus-stats/focus-stats.service.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import {
  GoalsController,
  RestDaysController,
  StreakController,
} from './consistency.controllers.js';
import { GoalsService } from './goals.service.js';
import { RestDaysService } from './rest-days.service.js';
import { StreakService } from './streak.service.js';
import { UserTodayService } from './user-today.service.js';

/** Goals, rest days, streaks, and streak recovery (Phase 3, A3.2). */
@Module({
  imports: [ProductConfigModule],
  controllers: [GoalsController, RestDaysController, StreakController],
  providers: [FocusStatsService, UserTodayService, GoalsService, RestDaysService, StreakService],
  exports: [FocusStatsService, UserTodayService, GoalsService, RestDaysService, StreakService],
})
export class ConsistencyModule {}
