import { createHash, randomBytes } from 'node:crypto';

/** An opaque, random refresh token (256 bits, base64url). */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Refresh tokens are stored only as this hash. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
