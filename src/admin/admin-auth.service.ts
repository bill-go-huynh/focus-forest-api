import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { PasswordHasher } from '../identity/password-hasher.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminAuditService } from './admin-audit.service.js';
import { ADMIN_TOKENS, type AdminTokens } from './admin-tokens.js';
import type { AdminSignInResponse } from './dto/admin-auth.dto.js';

const INVALID_CREDENTIALS = 'Email or password is incorrect.';

/** Admin sign-in (CR.3). An app user's credentials never sign in to the admin. */
@Injectable()
export class AdminAuthService {
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordHasher,
    @Inject(ADMIN_TOKENS) private readonly tokens: AdminTokens | null,
    private readonly audit: AdminAuditService,
    private readonly clock: Clock,
  ) {}

  async signIn(email: string, password: string): Promise<AdminSignInResponse> {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    if (!admin || admin.status !== 'active') {
      // The same time as a real check, so the answer does not reveal which admins exist.
      await this.passwords.verify(password, await this.getDummyHash());
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    if (!(await this.passwords.verify(password, admin.passwordHash))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    const { token, expiresAt } = await this.tokens!.issue(admin.id);
    await this.prisma.$transaction(async (tx) => {
      await tx.adminUser.update({
        where: { id: admin.id },
        data: { lastSignInAt: this.clock.now() },
      });
      await this.audit.record({ adminId: admin.id, action: 'admin.sign_in' }, tx);
    });
    return {
      accessToken: token,
      accessTokenExpiresAt: expiresAt.toISOString(),
      admin: { id: admin.id, email: admin.email, role: admin.role },
    };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwords.hash('not-a-real-admin-password');
    return this.dummyHash;
  }
}
