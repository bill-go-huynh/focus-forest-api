import { Module } from '@nestjs/common';

import { ProductConfigModule } from '../product-config/product-config.module.js';
import { MonthAttributionService } from './attribution/month-attribution.service.js';
import { SessionRulesController } from './session-rules.controller.js';
import { SessionsController } from './sessions.controller.js';
import { SessionsService } from './sessions.service.js';

/** Focus sessions (Phase 2). */
@Module({
  imports: [ProductConfigModule],
  controllers: [SessionRulesController, SessionsController],
  providers: [MonthAttributionService, SessionsService],
})
export class SessionsModule {}
