import { Module } from '@nestjs/common';

import { TopicsController } from './topics.controller.js';
import { TopicsService } from './topics.service.js';

/** Topics (Phase 2): create, edit, archive, restore. */
@Module({
  controllers: [TopicsController],
  providers: [TopicsService],
})
export class TopicsModule {}
