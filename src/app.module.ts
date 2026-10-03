import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ClockModule } from './common/clock.js';
import { validateEnv } from './config/env.validation.js';
import { ConsistencyModule } from './consistency/consistency.module.js';
import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProductConfigModule } from './product-config/product-config.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { TopicsModule } from './topics/topics.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    ClockModule,
    PrismaModule,
    ProductConfigModule,
    IdentityModule,
    TopicsModule,
    SessionsModule,
    ConsistencyModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
