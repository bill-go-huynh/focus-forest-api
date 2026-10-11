import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../config/env.validation.js';
import { IdentityModule } from '../identity/identity.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { BackgroundWorker } from './background-worker.js';
import { DevicesService } from './devices.service.js';
import { ExpoPushTransport } from './expo-push-transport.js';
import { DevicesController, FocusLeaseController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { DisabledPushTransport, PushTransport } from './push-transport.js';

/** A6.1 Notifications: devices, the focus lease, the outbox and its dispatcher, the worker. */
@Module({
  imports: [IdentityModule, JobsModule, ProductConfigModule],
  controllers: [DevicesController, FocusLeaseController],
  providers: [
    DevicesService,
    NotificationsService,
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
