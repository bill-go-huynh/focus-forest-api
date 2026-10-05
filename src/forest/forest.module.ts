import { Module } from '@nestjs/common';

import { ConsistencyModule } from '../consistency/consistency.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { ProgressionModule } from '../progression/progression.module.js';
import { TreesModule } from '../trees/trees.module.js';
import { ForestController } from './forest.controller.js';
import { ForestService } from './forest.service.js';

/** The Personal Forest, archived Tree Details, recaps, and month-end ceremony state (A3.4). */
@Module({
  imports: [ProductConfigModule, ConsistencyModule, TreesModule, ProgressionModule],
  controllers: [ForestController],
  providers: [ForestService],
  exports: [ForestService],
})
export class ForestModule {}
