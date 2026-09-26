import { jwtVerify, SignJWT } from 'jose';

import type { Clock } from '../common/clock.js';

const ALGORITHM = 'HS256';
const ISSUER = 'focus-forest-api';
const AUDIENCE = 'focus-forest';
const TOKEN_TYPE = 'access';

export interface AccessTokenOptions {
  secret: string;
  ttlSeconds: number;
}

/** Short-lived, signed access tokens (JWT, HS256). */
export class AccessTokens {
  private readonly key: Uint8Array;

  constructor(
    private readonly options: AccessTokenOptions,
    private readonly clock: Clock,
  ) {
    if (options.secret.length < 32) {
      throw new Error('The access token secret must be at least 32 characters long.');
    }
    this.key = new TextEncoder().encode(options.secret);
  }

  async issue(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.options.ttlSeconds * 1000);
    const token = await new SignJWT({ typ: TOKEN_TYPE })
      .setProtectedHeader({ alg: ALGORITHM })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .sign(this.key);
    return { token, expiresAt };
  }

  /** Returns the user for a valid, unexpired access token, and null for anything else. */
  async verify(token: string): Promise<{ userId: string } | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: this.clock.now(),
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      if (payload['typ'] !== TOKEN_TYPE || !payload.sub) return null;
      return { userId: payload.sub };
    } catch {
      return null;
    }
  }
}
