import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module.js';
import { EventsModule } from '../events/events.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { ProgressionModule } from '../progression/progression.module.js';
import { AttributionModule } from '../sessions/attribution/attribution.module.js';
import { SocialModule } from '../social/social.module.js';
import { TreesModule } from '../trees/trees.module.js';
import { DemoController, DemoEnabledGuard } from './demo.controller.js';
import { DemoEvents, DemoLiveGateway } from './demo-live.gateway.js';
import { DemoService } from './demo.service.js';

/** DM.1 Demo tools (spec/demo/PLAN.md): local demo and QA only. */
@Module({
  imports: [
    AdminModule,
    AttributionModule,
    EventsModule,
    IdentityModule,
    NotificationsModule,
    ProductConfigModule,
    ProgressionModule,
    SocialModule,
    TreesModule,
  ],
  controllers: [DemoController],
  providers: [DemoService, DemoEnabledGuard, DemoEvents, DemoLiveGateway],
})
export class DemoModule {}
