import { Module } from '@nestjs/common';

import { ConsistencyModule } from '../consistency/consistency.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { ProgressionModule } from '../progression/progression.module.js';
import { TreesModule } from '../trees/trees.module.js';
import { CommunityTreeService } from './community-tree.service.js';
import { EventNoticesService } from './event-notices.service.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

/**
 * A5.6 Events and missions, with their notices (A6.3). Sessions and Home use it; it never imports
 * them.
 */
@Module({
  imports: [
    ConsistencyModule,
    ProgressionModule,
    TreesModule,
    JobsModule,
    NotificationsModule,
    ProductConfigModule,
  ],
  controllers: [EventsController],
  providers: [EventsService, CommunityTreeService, EventNoticesService],
  exports: [EventsService],
})
export class EventsModule {}
