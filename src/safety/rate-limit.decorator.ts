import { SetMetadata } from '@nestjs/common';

/** The configured limits (`rateLimit.<name>` in the product configuration, A7.2). */
export const RATE_LIMIT_NAMES = [
  'signUp',
  'signIn',
  'refresh',
  'deleteAttempts',
  'reports',
  'follows',
  'reactions',
  'invites',
  'roomCodes',
  'search',
  'analytics',
  'clientErrors',
] as const;
export type RateLimitName = (typeof RATE_LIMIT_NAMES)[number];

/** What a limit counts per: the client address, the email in the body, or the signed-in user. */
export type RateLimitKey = 'ip' | 'email' | 'user';

export const RATE_LIMIT = 'safety:rateLimit';

export interface RateLimitRule {
  name: RateLimitName;
  per: readonly RateLimitKey[];
}

/**
 * Limits a route (A7.2): each request counts once per key in `per`, in the limit's window, and
 * is refused with 429 once any count is past the limit.
 */
export const RateLimit = (name: RateLimitName, ...per: RateLimitKey[]) =>
  SetMetadata(RATE_LIMIT, { name, per } satisfies RateLimitRule);
