import { Module } from '@nestjs/common';

import { ConsistencyModule } from '../consistency/consistency.module.js';
import { AchievementsService } from './achievements.service.js';
import { ProgressionOwnershipService } from './progression-ownership.service.js';
import { ProgressionController } from './progression.controller.js';

/**
 * Progression (Phase 4): content definitions (seed data) and permanent ownership (A4.1);
 * achievements, badges, and the showcase (A4.2). Species and cosmetics (A4.3) and the
 * collection (A4.4) build on it.
 */
@Module({
  imports: [ConsistencyModule],
  controllers: [ProgressionController],
  providers: [ProgressionOwnershipService, AchievementsService],
  exports: [ProgressionOwnershipService, AchievementsService],
})
export class ProgressionModule {}
