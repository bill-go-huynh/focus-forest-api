import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import type { Clock } from '../common/clock.js';

/** Google's published signing keys (OpenID discovery, `jwks_uri`). */
export const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleAccount {
  /** Google's stable id for the account (`sub`). Emails can change; this does not. */
  subject: string;
  /** Trimmed and lowercased, like our own emails. Always verified by Google. */
  email: string;
  name: string | null;
}

export interface GoogleIdTokenOptions {
  /** Our OAuth client ids a token may be issued for (its audience). None turns Google off. */
  clientIds: readonly string[];
  keys: JWTVerifyGetKey;
}

/**
 * W.2 Verifies Google ID tokens (docs/08 §3: extra sign-in methods, users stay ours). A token is
 * trusted only when Google signed it, for one of our clients, unexpired, with a verified email.
 */
export class GoogleIdTokens {
  constructor(
    private readonly options: GoogleIdTokenOptions,
    private readonly clock: Clock,
  ) {}

  static remote(clientIds: readonly string[], clock: Clock): GoogleIdTokens {
    return new GoogleIdTokens(
      { clientIds, keys: createRemoteJWKSet(new URL(GOOGLE_KEYS_URL)) },
      clock,
    );
  }

  get enabled(): boolean {
    return this.options.clientIds.length > 0;
  }

  /** The Google account of a valid token, and null for anything else. */
  async verify(idToken: string): Promise<GoogleAccount | null> {
    if (!this.enabled) return null;
    try {
      const { payload } = await jwtVerify(idToken, this.options.keys, {
        algorithms: ['RS256'],
        issuer: ISSUERS,
        audience: [...this.options.clientIds],
        currentDate: this.clock.now(),
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      const email = payload['email'];
      if (!payload.sub || typeof email !== 'string' || payload['email_verified'] !== true) {
        return null;
      }
      const name = payload['name'];
      return {
        subject: payload.sub,
        email: email.trim().toLowerCase(),
        name: typeof name === 'string' && name.trim() ? name.trim() : null,
      };
    } catch {
      return null;
    }
  }
}
