import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { Clock } from '../common/clock.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessTokens } from './access-tokens.js';
import { DISPLAY_NAME_MAX_LENGTH } from './dto/profile.dto.js';
import { GoogleIdTokens, type GoogleAccount } from './google-id-tokens.js';
import { PasswordHasher } from './password-hasher.js';
import { generateRefreshToken, hashRefreshToken } from './refresh-tokens.js';

export interface AuthResult {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  /** W.2 How the account signs in: with its password, or only with Google. */
  user: { id: string; email: string; signInMethod: SignInMethod };
}

export type SignInMethod = 'password' | 'google';

/** W.2 `POST /auth/google`: also whether the account was just created (it then onboards). */
export interface GoogleAuthResult extends AuthResult {
  created: boolean;
}

type TokenUser = { id: string; email: string; passwordHash: string | null };

const INVALID_CREDENTIALS = 'Email or password is incorrect.';
const INVALID_REFRESH = 'Sign in again to continue.';
const GOOGLE_UNCONFIRMED = 'Google sign-in could not be confirmed.';
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
    private readonly google: GoogleIdTokens,
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
    // A Google-only account has no password (W.2): it is refused like a wrong one.
    const hash = user.passwordHash ?? (await this.getDummyHash());
    if (!(await this.passwords.verify(password, hash)) || !user.passwordHash) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    assertActive(user);
    return this.issueTokens(user, randomUUID());
  }

  /**
   * W.2 Signs a Google account in (docs/08 §3: an extra sign-in method; users stay ours). The
   * Google account is followed by its stable id, not its email. A new one creates an account with
   * no password, its Google name and the device time zone in the profile. An email that already
   * belongs to another account is never taken over: sign-up checks no email, so linking it would
   * hand a pre-registered account to whoever made it.
   */
  async signInWithGoogle(idToken: string, timezone?: string): Promise<GoogleAuthResult> {
    if (!this.google.enabled) {
      throw new ServiceUnavailableException('Google sign-in is not available.');
    }
    const account = await this.google.verify(idToken);
    if (!account) throw new UnauthorizedException(GOOGLE_UNCONFIRMED);

    const linked = await this.findGoogleUser(account.subject);
    if (linked) {
      assertActive(linked);
      return { ...(await this.issueTokens(linked, randomUUID())), created: false };
    }
    try {
      const user = await this.prisma.user.create({
        data: {
          email: account.email,
          passwordHash: null,
          displayName: displayNameOf(account),
          timezone: timezone ?? null,
          identities: { create: { provider: 'google', subject: account.subject } },
        },
      });
      return { ...(await this.issueTokens(user, randomUUID())), created: true };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
      // The same Google account, created by a concurrent request: sign that one in.
      const raced = await this.findGoogleUser(account.subject);
      if (raced) {
        assertActive(raced);
        return { ...(await this.issueTokens(raced, randomUUID())), created: false };
      }
      const existing = await this.prisma.user.findUnique({
        where: { email: account.email },
        select: { passwordHash: true },
      });
      throw new ConflictException(
        existing?.passwordHash
          ? {
              statusCode: 409,
              error: 'Conflict',
              message: 'This email already has a Focus Forest account. Sign in with your password.',
              code: 'email_has_password',
            }
          : {
              statusCode: 409,
              error: 'Conflict',
              message: 'This email already belongs to another Focus Forest account.',
              code: 'email_in_use',
            },
      );
    }
  }

  /** W.3 A new sign-in for an account whose password was just reset. */
  startSession(user: TokenUser): Promise<AuthResult> {
    return this.issueTokens(user, randomUUID());
  }

  private async findGoogleUser(subject: string) {
    const identity = await this.prisma.userIdentity.findUnique({
      where: { provider_subject: { provider: 'google', subject } },
      include: { user: true },
    });
    return identity?.user ?? null;
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

  private async issueTokens(user: TokenUser, familyId: string): Promise<AuthResult> {
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
      user: {
        id: user.id,
        email: user.email,
        signInMethod: user.passwordHash ? 'password' : 'google',
      },
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

function assertActive(user: { status: string }): void {
  if (user.status !== 'active') {
    throw new ForbiddenException(
      user.status === 'banned' ? 'This account is banned.' : 'This account is suspended.',
    );
  }
}

/** The Google name for the profile: no control characters, within the display name limit. */
function displayNameOf(account: GoogleAccount): string | null {
  if (!account.name) return null;
  const clean = account.name.replace(/\p{Cc}/gu, ' ').trim();
  return clean ? Array.from(clean).slice(0, DISPLAY_NAME_MAX_LENGTH).join('').trim() : null;
}
