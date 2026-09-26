import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import { Clock } from '../common/clock.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { AccessTokenGuard } from './access-token.guard.js';
import { AccessTokens } from './access-tokens.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordHasher } from './password-hasher.js';
import { PreferencesController } from './preferences.controller.js';
import { PreferencesService } from './preferences.service.js';
import { ProfileController } from './profile.controller.js';
import { ProfileService } from './profile.service.js';

@Module({
  controllers: [AuthController, ProfileController, PreferencesController],
  providers: [
    AuthService,
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
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
})
export class IdentityModule {}
