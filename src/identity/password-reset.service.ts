import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { Clock } from '../common/clock.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { Mailer } from '../mail/mailer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService, type AuthResult } from './auth.service.js';
import { PasswordHasher } from './password-hasher.js';

/** How long a code works, and how many tries it allows (technical limits, not product tuning). */
export const RESET_CODE_TTL_MINUTES = 15;
export const RESET_CODE_MAX_ATTEMPTS = 5;
const MINUTE_MS = 60_000;

const CODE_INVALID = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'That code is not right, or it has expired. Ask for a new one.',
  code: 'reset_code_invalid',
};

/**
 * W.3 Forgot password (owner decision 2026-10-18; no email verification). A request emails a
 * 6-digit code to the account's address; the code and a new password set the password, sign out
 * every other device, and sign this one in.
 *
 * - The request answers the same for every email, and all its work (the code, the email) runs
 *   after the answer, so neither the answer nor its timing says whether an account exists.
 * - Only an HMAC of the code is stored. A code works once, for RESET_CODE_TTL_MINUTES, for
 *   RESET_CODE_MAX_ATTEMPTS tries; a new request replaces it.
 * - An account that signs in only with Google gets an email saying so, and no code.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger('PasswordReset');

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordHasher,
    private readonly auth: AuthService,
    private readonly mailer: Mailer,
    private readonly clock: Clock,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  request(email: string): void {
    void this.deliver(email).catch(() => {
      // Never the email or the code (docs: no personal data or secrets in logs).
      this.logger.warn('A password reset email could not be sent.');
    });
  }

  async confirm(email: string, code: string, newPassword: string): Promise<AuthResult> {
    const now = this.clock.now();
    const user = await this.prisma.user.findUnique({ where: { email } });
    const latest = user
      ? await this.prisma.passwordResetCode.findFirst({
          where: { userId: user.id, usedAt: null },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    if (!user || !latest || latest.expiresAt <= now || latest.attempts >= RESET_CODE_MAX_ATTEMPTS) {
      throw new BadRequestException(CODE_INVALID);
    }
    if (!this.matches(latest.codeHash, user.id, code)) {
      await this.prisma.passwordResetCode.updateMany({
        where: { id: latest.id, attempts: { lt: RESET_CODE_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException(CODE_INVALID);
    }
    if (user.status !== 'active') {
      throw new ForbiddenException(
        user.status === 'banned' ? 'This account is banned.' : 'This account is suspended.',
      );
    }

    const passwordHash = await this.passwords.hash(newPassword);
    const updated = await this.prisma.$transaction(async (tx) => {
      // Only one request can use the code.
      const { count } = await tx.passwordResetCode.updateMany({
        where: { id: latest.id, usedAt: null, attempts: { lt: RESET_CODE_MAX_ATTEMPTS } },
        data: { usedAt: now },
      });
      if (count !== 1) return null;
      await tx.passwordResetCode.deleteMany({ where: { userId: user.id, id: { not: latest.id } } });
      // Every other device signs in again.
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      return tx.user.update({ where: { id: user.id }, data: { passwordHash } });
    });
    if (!updated) throw new BadRequestException(CODE_INVALID);
    return this.auth.startSession(updated);
  }

  private async deliver(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, status: true, passwordHash: true },
    });
    if (!user || user.status !== 'active') return;
    if (!user.passwordHash) {
      await this.mailer.send({
        to: email,
        subject: 'How you sign in to Focus Forest',
        text: [
          'Someone asked to reset the password of your Focus Forest account.',
          'Your account has no password: you sign in with Google. Open Focus Forest and choose Continue with Google.',
          "If you didn't ask, you can ignore this email.",
        ].join('\n\n'),
      });
      return;
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const now = this.clock.now();
    await this.prisma.$transaction([
      // Only the newest code works.
      this.prisma.passwordResetCode.deleteMany({ where: { userId: user.id } }),
      this.prisma.passwordResetCode.create({
        data: {
          userId: user.id,
          codeHash: this.hash(user.id, code),
          expiresAt: new Date(now.getTime() + RESET_CODE_TTL_MINUTES * MINUTE_MS),
        },
      }),
    ]);
    await this.mailer.send({
      to: email,
      subject: 'Your Focus Forest code',
      text: [
        `Your code to set a new Focus Forest password is ${code}.`,
        `It works for ${RESET_CODE_TTL_MINUTES} minutes. Setting a new password signs you out on your other devices.`,
        "If you didn't ask for it, you can ignore this email: your password stays the same.",
      ].join('\n\n'),
    });
  }

  private hash(userId: string, code: string): string {
    return createHmac('sha256', this.config.get('JWT_ACCESS_SECRET', { infer: true }))
      .update(`password-reset:${userId}:${code}`)
      .digest('hex');
  }

  private matches(stored: string, userId: string, code: string): boolean {
    const expected = Buffer.from(stored, 'hex');
    const actual = Buffer.from(this.hash(userId, code), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
