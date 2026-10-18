import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import { Clock } from '../common/clock.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { AccessTokenGuard } from './access-token.guard.js';
import { AccessTokens } from './access-tokens.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { GoogleIdTokens } from './google-id-tokens.js';
import { PasswordHasher } from './password-hasher.js';
import { PasswordResetService } from './password-reset.service.js';
import { PreferencesController } from './preferences.controller.js';
import { PreferencesService } from './preferences.service.js';
import { ProfileController } from './profile.controller.js';
import { ProfileService } from './profile.service.js';

@Module({
  imports: [AnalyticsModule],
  controllers: [AuthController, ProfileController, PreferencesController, AccountController],
  providers: [
    AccountService,
    AuthService,
    PasswordResetService,
    ProfileService,
    PreferencesService,
    { provide: PasswordHasher, useFactory: () => new PasswordHasher() },
    {
      provide: AccessTokens,
      inject: [ConfigService, Clock],
      useFactory: (config: ConfigService<EnvironmentVariables, true>, clock: Clock) =>
        new AccessTokens(
          {
            secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
            ttlSeconds: config.get('ACCESS_TOKEN_TTL_SECONDS', { infer: true }),
          },
          clock,
        ),
    },
    {
      provide: GoogleIdTokens,
      inject: [ConfigService, Clock],
      useFactory: (config: ConfigService<EnvironmentVariables, true>, clock: Clock) =>
        GoogleIdTokens.remote(
          (config.get('GOOGLE_CLIENT_IDS', { infer: true }) ?? '')
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
          clock,
        ),
    },
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
  exports: [PasswordHasher, AccessTokens],
})
export class IdentityModule {}
