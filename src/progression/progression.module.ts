import { Module } from '@nestjs/common';

import { ConsistencyModule } from '../consistency/consistency.module.js';
import { AchievementsService } from './achievements.service.js';
import { ProgressionOwnershipService } from './progression-ownership.service.js';
import { ProgressionController } from './progression.controller.js';
import { RewardsService } from './rewards.service.js';

/**
 * Progression (Phase 4): content definitions (seed data) and permanent ownership (A4.1);
 * achievements, badges, and the showcase (A4.2); species, cosmetics, and equipment (A4.3).
 * The collection (A4.4) builds on it.
 */
@Module({
  imports: [ConsistencyModule],
  controllers: [ProgressionController],
  providers: [ProgressionOwnershipService, AchievementsService, RewardsService],
  exports: [ProgressionOwnershipService, AchievementsService, RewardsService],
})
export class ProgressionModule {}
