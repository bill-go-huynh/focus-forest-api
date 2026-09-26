import { generateRefreshToken, hashRefreshToken } from './refresh-tokens.js';

describe('refresh tokens', () => {
  it('are random, URL-safe, and carry at least 256 bits', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it('are stored as a deterministic hash that differs from the token', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).not.toContain(token);
    expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
