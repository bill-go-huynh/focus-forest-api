import { Module } from '@nestjs/common';

import { ConsistencyModule } from '../consistency/consistency.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { AttributionModule } from '../sessions/attribution/attribution.module.js';
import { TopicsModule } from '../topics/topics.module.js';
import { MonthlyTreesService } from './monthly-trees.service.js';
import { TreesController } from './trees.controller.js';

/** Monthly trees and Home (Phase 3, A3.3). */
@Module({
  imports: [ProductConfigModule, AttributionModule, ConsistencyModule, TopicsModule],
  controllers: [TreesController],
  providers: [MonthlyTreesService],
  exports: [MonthlyTreesService],
})
export class TreesModule {}
