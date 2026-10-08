import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { FixedClock } from '../common/clock.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AdminTokens } from './admin-tokens.js';
import { AdminGuard } from './admin.guard.js';

const context = (authorization?: string): ExecutionContext =>
  ({
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
  }) as unknown as ExecutionContext;

const prisma = {
  adminUser: { findUnique: () => Promise.resolve(null) },
} as unknown as PrismaService;
const clock = new FixedClock(new Date('2026-10-08T12:00:00.000Z'));

describe('AdminGuard (CR.3)', () => {
  it('turns every admin route off when the admin is not configured', async () => {
    const guard = new AdminGuard(new Reflector(), null, prisma);
    await expect(guard.canActivate(context('Bearer x'))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('refuses a missing token, and a token signed for the app', async () => {
    const admin = new AdminTokens({ secret: 'a'.repeat(32), ttlSeconds: 1800 }, clock);
    const guard = new AdminGuard(new Reflector(), admin, prisma);
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);
    // Same secret, different audience: still not an admin token.
    const { AccessTokens } = await import('../identity/access-tokens.js');
    const app = await new AccessTokens({ secret: 'a'.repeat(32), ttlSeconds: 900 }, clock).issue(
      'user-1',
    );
    expect(await admin.verify(app.token)).toBeNull();
  });
});
