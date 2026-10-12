import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { ProgressionModule } from '../progression/progression.module.js';
import {
  AdminRoomsController,
  RoomInvitesController,
  RoomsController,
} from './rooms.controller.js';
import { RoomsGateway } from './rooms.gateway.js';
import { RoomEvents, RoomsService } from './rooms.service.js';

/** A5.4 Focus Together: rooms, the live channel, and admin room oversight. */
@Module({
  imports: [
    IdentityModule,
    AdminModule,
    ProgressionModule,
    ProductConfigModule,
    NotificationsModule,
  ],
  controllers: [RoomsController, RoomInvitesController, AdminRoomsController],
  providers: [RoomsService, RoomEvents, RoomsGateway],
})
export class RoomsModule {}
