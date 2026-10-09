import { Module } from '@nestjs/common';

import { ConsistencyModule } from '../consistency/consistency.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { ProgressionModule } from '../progression/progression.module.js';
import { SocialModule } from '../social/social.module.js';
import { TreesModule } from '../trees/trees.module.js';
import { VisitsController } from './visits.controller.js';
import { VisitsService } from './visits.service.js';

/**
 * A5.2 visits: reads other users' Core and Progression state through the Social visibility gate.
 * It sits above them, like session submission: Social never imports Core or Progression.
 */
@Module({
  imports: [SocialModule, TreesModule, ConsistencyModule, ProgressionModule, ProductConfigModule],
  controllers: [VisitsController],
  providers: [VisitsService],
})
export class VisitsModule {}
