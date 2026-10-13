import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Clock } from '../common/clock.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { ConsistencyModule } from '../consistency/consistency.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ProgressionModule } from '../progression/progression.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { AdminAuditController } from './admin-audit.controller.js';
import { AdminAuditService } from './admin-audit.service.js';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminConfigController } from './admin-config.controller.js';
import { AdminConfigService } from './admin-config.service.js';
import { AdminOverviewController } from './admin-overview.controller.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminSupportService } from './admin-support.service.js';
import { AdminUsersService } from './admin-users.service.js';
import { ADMIN_TOKENS, AdminTokens } from './admin-tokens.js';
import { AdminGuard } from './admin.guard.js';

/**
 * The early admin (docs/09, CR.3–CR.4): admins, their sign-in, roles, and the audit log. Without
 * ADMIN_JWT_SECRET the admin is off: every admin route answers 503 `admin_disabled`.
 */
@Module({
  imports: [
    IdentityModule,
    ConsistencyModule,
    ProductConfigModule,
    AnalyticsModule,
    ProgressionModule,
  ],
  controllers: [
    AdminAuthController,
    AdminAuditController,
    AdminUsersController,
    AdminOverviewController,
    AdminConfigController,
  ],
  providers: [
    AdminAuthService,
    AdminAuditService,
    AdminUsersService,
    AdminSupportService,
    AdminConfigService,
    AdminGuard,
    {
      provide: ADMIN_TOKENS,
      inject: [ConfigService, Clock],
      useFactory: (config: ConfigService<EnvironmentVariables, true>, clock: Clock) => {
        const secret = config.get('ADMIN_JWT_SECRET', { infer: true });
        return secret
          ? new AdminTokens(
              { secret, ttlSeconds: config.get('ADMIN_TOKEN_TTL_SECONDS', { infer: true }) },
              clock,
            )
          : null;
      },
    },
  ],
  exports: [AdminAuditService, AdminGuard, ADMIN_TOKENS],
})
export class AdminModule {}
