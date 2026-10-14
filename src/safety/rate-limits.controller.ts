import { Get } from '@nestjs/common';

import { AdminController, AdminRoles } from '../admin/admin-route.decorator.js';
import { Clock } from '../common/clock.js';
import { RateLimitService } from './rate-limit.service.js';

/** D7.1 Rate-limit refusals over the last day (admins and support, with the app errors). */
@AdminController('rate-limits')
@AdminRoles('admin', 'support')
export class AdminRateLimitsController {
  constructor(
    private readonly limits: RateLimitService,
    private readonly clock: Clock,
  ) {}

  @Get()
  refusals() {
    return this.limits.refusals(this.clock.now());
  }
}
