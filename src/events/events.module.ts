import { Module } from '@nestjs/common';

import { ConsistencyModule } from '../consistency/consistency.module.js';
import { ProgressionModule } from '../progression/progression.module.js';
import { TreesModule } from '../trees/trees.module.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

/** A5.6 Events and missions. Sessions and Home use it; it never imports them. */
@Module({
  imports: [ConsistencyModule, ProgressionModule, TreesModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
