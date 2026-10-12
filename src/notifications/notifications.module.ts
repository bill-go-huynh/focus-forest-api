import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../config/env.validation.js';
import { ConsistencyModule } from '../consistency/consistency.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { BackgroundWorker } from './background-worker.js';
import { DevicesService } from './devices.service.js';
import { ExpoPushTransport } from './expo-push-transport.js';
import { DevicesController, FocusLeaseController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { RemindersService } from './reminders.service.js';
import { DisabledPushTransport, PushTransport } from './push-transport.js';

/**
 * Notifications: devices, the focus lease, the outbox and its dispatcher, the worker (A6.1), and
 * the reminders (A6.2).
 */
@Module({
  imports: [IdentityModule, JobsModule, ProductConfigModule, ConsistencyModule],
  controllers: [DevicesController, FocusLeaseController],
  providers: [
    DevicesService,
    NotificationsService,
    RemindersService,
    BackgroundWorker,
    {
      provide: PushTransport,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        config.get('PUSH_PROVIDER', { infer: true }) === 'expo'
          ? new ExpoPushTransport({
              fetch: globalThis.fetch,
              accessToken: config.get('EXPO_ACCESS_TOKEN', { infer: true }) ?? null,
            })
          : new DisabledPushTransport(),
    },
  ],
  exports: [NotificationsService, JobsModule],
})
export class NotificationsModule {}
