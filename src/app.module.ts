import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AdminModule } from './admin/admin.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { ClockModule } from './common/clock.js';
import { validateEnv } from './config/env.validation.js';
import { ConsistencyModule } from './consistency/consistency.module.js';
import { ForestModule } from './forest/forest.module.js';
import { HealthController } from './health/health.controller.js';
import { HomeModule } from './home/home.module.js';
import { InsightsModule } from './insights/insights.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProductConfigModule } from './product-config/product-config.module.js';
import { ProgressionModule } from './progression/progression.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { SocialModule } from './social/social.module.js';
import { StreakRecoveryModule } from './streak-recovery/streak-recovery.module.js';
import { TopicsModule } from './topics/topics.module.js';
import { TreesModule } from './trees/trees.module.js';

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
    TreesModule,
    ForestModule,
    HomeModule,
    InsightsModule,
    ProgressionModule,
    StreakRecoveryModule,
    SocialModule,
    AnalyticsModule,
    AdminModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
