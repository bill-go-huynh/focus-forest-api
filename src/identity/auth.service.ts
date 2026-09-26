import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { Clock } from '../common/clock.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessTokens } from './access-tokens.js';
import { PasswordHasher } from './password-hasher.js';
import { generateRefreshToken, hashRefreshToken } from './refresh-tokens.js';

export interface AuthResult {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: { id: string; email: string };
}

const INVALID_CREDENTIALS = 'Email or password is incorrect.';
const INVALID_REFRESH = 'Sign in again to continue.';
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordHasher,
    private readonly accessTokens: AccessTokens,
    private readonly clock: Clock,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  async signUp(email: string, password: string): Promise<AuthResult> {
    const passwordHash = await this.passwords.hash(password);
    try {
      const user = await this.prisma.user.create({ data: { email, passwordHash } });
      return await this.issueTokens(user, randomUUID());
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An account with this email already exists.');
      }
      throw error;
    }
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Spend the same time as a real check, so response time doesn't reveal which emails exist.
      await this.passwords.verify(password, await this.getDummyHash());
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    if (!(await this.passwords.verify(password, user.passwordHash))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    if (user.status !== 'active') {
      throw new ForbiddenException('This account is suspended.');
    }
    return this.issueTokens(user, randomUUID());
  }

  /** Exchanges a refresh token for a new pair. Each refresh token works once. */
  async refresh(refreshToken: string): Promise<AuthResult> {
    const now = this.clock.now();
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(refreshToken) },
      include: { user: true },
    });
    if (!stored) throw new UnauthorizedException(INVALID_REFRESH);

    if (stored.usedAt || stored.revokedAt) {
      // A used token presented again may have been stolen: end the whole sign-in.
      await this.revokeFamily(stored.familyId, now);
      throw new UnauthorizedException(INVALID_REFRESH);
    }
    if (stored.expiresAt <= now || stored.user.status !== 'active') {
      throw new UnauthorizedException(INVALID_REFRESH);
    }

    // Only one concurrent request can use the token; a second one counts as a replay.
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, usedAt: null, revokedAt: null },
      data: { usedAt: now },
    });
    if (count !== 1) {
      await this.revokeFamily(stored.familyId, now);
      throw new UnauthorizedException(INVALID_REFRESH);
    }
    return this.issueTokens(stored.user, stored.familyId);
  }

  private async issueTokens(
    user: { id: string; email: string },
    familyId: string,
  ): Promise<AuthResult> {
    const now = this.clock.now();
    const refreshToken = generateRefreshToken();
    const refreshTokenExpiresAt = new Date(
      now.getTime() + this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * DAY_MS,
    );
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: refreshTokenExpiresAt,
      },
    });
    const access = await this.accessTokens.issue(user.id);

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
      user: { id: user.id, email: user.email },
    };
  }

  private async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwords.hash('dummy password for timing equalization');
    return this.dummyHash;
  }
}
