import { Module } from '@nestjs/common';

import { ConsistencyModule } from '../consistency/consistency.module.js';
import { TreesModule } from '../trees/trees.module.js';
import { InsightsController } from './insights.controller.js';
import { InsightsService } from './insights.service.js';

/** Insights, personal records, and lifetime stats (Phase 3, A3.5). */
@Module({
  imports: [ConsistencyModule, TreesModule],
  controllers: [InsightsController],
  providers: [InsightsService],
})
export class InsightsModule {}
