import { Module } from '@nestjs/common';

import { ProductConfigModule } from '../product-config/product-config.module.js';
import { ProgressionModule } from '../progression/progression.module.js';
import { TreesModule } from '../trees/trees.module.js';
import { AttributionModule } from './attribution/attribution.module.js';
import { SessionRulesController } from './session-rules.controller.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

/** Focus sessions (Phase 2). */
@Module({
  imports: [ProductConfigModule, AttributionModule, TreesModule, ProgressionModule],
  controllers: [SessionRulesController, SessionsController],
  providers: [SessionsService],
})
export class SessionsModule {}
