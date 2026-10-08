import { jwtVerify, SignJWT } from 'jose';

import type { Clock } from '../common/clock.js';

const ALGORITHM = 'HS256';
const ISSUER = 'focus-forest-api';
/** A different audience and secret from app tokens: neither kind is ever accepted for the other. */
const AUDIENCE = 'focus-forest-admin';
const TOKEN_TYPE = 'admin';

/** The injection token of `AdminTokens`, or null when the admin is not configured. */
export const ADMIN_TOKENS = Symbol('AdminTokens');

export interface AdminTokenOptions {
  secret: string;
  ttlSeconds: number;
}

/** Short-lived admin access tokens (JWT, HS256), with no refresh: an admin signs in again. */
export class AdminTokens {
  private readonly key: Uint8Array;

  constructor(
    private readonly options: AdminTokenOptions,
    private readonly clock: Clock,
  ) {
    if (options.secret.length < 32) {
      throw new Error('The admin token secret must be at least 32 characters long.');
    }
    this.key = new TextEncoder().encode(options.secret);
  }

  async issue(adminId: string): Promise<{ token: string; expiresAt: Date }> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.options.ttlSeconds * 1000);
    const token = await new SignJWT({ typ: TOKEN_TYPE })
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(adminId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .sign(this.key);
    return { token, expiresAt };
  }

  /** The admin of a valid, unexpired admin token; null for anything else (an app token too). */
  async verify(token: string): Promise<{ adminId: string } | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: this.clock.now(),
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      if (payload['typ'] !== TOKEN_TYPE || !payload.sub) return null;
      return { adminId: payload.sub };
    } catch {
      return null;
    }
  }
}
