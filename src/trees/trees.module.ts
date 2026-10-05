import { Module } from '@nestjs/common';

import { ConsistencyModule } from '../consistency/consistency.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { ProgressionModule } from '../progression/progression.module.js';
import { AttributionModule } from '../sessions/attribution/attribution.module.js';
import { MonthClosureService } from './month-closure.service.js';
import { MonthlyTreesService } from './monthly-trees.service.js';
import { TreesController } from './trees.controller.js';

/** Monthly trees (Phase 3, A3.3) and month closure (A3.4). */
@Module({
  imports: [ProductConfigModule, AttributionModule, ConsistencyModule, ProgressionModule],
  controllers: [TreesController],
  providers: [MonthlyTreesService, MonthClosureService],
  exports: [MonthlyTreesService, MonthClosureService],
})
export class TreesModule {}
