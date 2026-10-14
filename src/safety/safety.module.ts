import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AdminModule } from '../admin/admin.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { IntegrityController } from './integrity.controller.js';
import { IntegrityService } from './integrity.service.js';
import { AdminRateLimitsController } from './rate-limits.controller.js';
import { RateLimitInterceptor } from './rate-limit.interceptor.js';
import { RateLimitService } from './rate-limit.service.js';

/**
 * Abuse and safety: rate limits on every route marked `@RateLimit` (A7.2), and leaderboard
 * integrity flags for staff (A7.3).
 */
@Module({
  imports: [ProductConfigModule, JobsModule, AdminModule],
  controllers: [IntegrityController, AdminRateLimitsController],
  providers: [
    RateLimitService,
    IntegrityService,
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
  ],
  exports: [RateLimitService],
})
export class SafetyModule {}
