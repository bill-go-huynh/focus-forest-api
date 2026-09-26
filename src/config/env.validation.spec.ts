import 'reflect-metadata';

import { validateEnv } from './env.validation.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('validateEnv (auth settings)', () => {
  it('uses a 15-minute access token and 30-day refresh token by default', () => {
    const env = validateEnv(base);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(30);
  });

  it('refuses to start without an access token secret', () => {
    expect(() => validateEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('refuses a secret shorter than 32 characters, without printing it', () => {
    const attempt = () => validateEnv({ ...base, JWT_ACCESS_SECRET: 'short-secret-value' });
    expect(attempt).toThrow(/JWT_ACCESS_SECRET/);
    expect(attempt).not.toThrow(/short-secret-value/);
  });

  it('refuses an access token TTL above one hour', () => {
    expect(() => validateEnv({ ...base, ACCESS_TOKEN_TTL_SECONDS: '86400' })).toThrow(
      /ACCESS_TOKEN_TTL_SECONDS/,
    );
  });
});
