import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { JobsModule } from '../jobs/jobs.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { RateLimitInterceptor } from './rate-limit.interceptor.js';
import { RateLimitService } from './rate-limit.service.js';

/** A7.2 Abuse and safety: rate limits on every route marked `@RateLimit`. */
@Module({
  imports: [ProductConfigModule, JobsModule],
  providers: [RateLimitService, { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor }],
  exports: [RateLimitService],
})
export class SafetyModule {}
