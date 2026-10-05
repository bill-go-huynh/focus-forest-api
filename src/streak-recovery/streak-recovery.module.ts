import { Module } from '@nestjs/common';

import { ConsistencyModule } from '../consistency/consistency.module.js';
import { ProgressionModule } from '../progression/progression.module.js';
import { StreakRecoveryController } from './streak-recovery.controller.js';
import { StreakRecoveryService } from './streak-recovery.service.js';

/**
 * The streak-recovery action (A4.2.G): above Consistency (the recovery rules and state) and
 * Progression (what the recovery earns), like session submission above trees and progression.
 */
@Module({
  imports: [ConsistencyModule, ProgressionModule],
  controllers: [StreakRecoveryController],
  providers: [StreakRecoveryService],
})
export class StreakRecoveryModule {}
