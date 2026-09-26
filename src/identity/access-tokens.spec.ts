import { SignJWT } from 'jose';

import { FixedClock } from '../common/clock.js';
import { AccessTokens } from './access-tokens.js';

const SECRET = 'test-access-secret-that-is-at-least-32-characters';
const START = new Date('2026-09-01T10:00:00Z');

function setup() {
  const clock = new FixedClock(START);
  const tokens = new AccessTokens({ secret: SECRET, ttlSeconds: 900 }, clock);
  return { clock, tokens };
}

describe('AccessTokens', () => {
  it('issues a token that verifies to its user', async () => {
    const { tokens } = setup();
    const { token } = await tokens.issue('user-1');
    await expect(tokens.verify(token)).resolves.toEqual({ userId: 'user-1' });
  });

  it('is short-lived: it expires after its TTL', async () => {
    const { clock, tokens } = setup();
    const { token, expiresAt } = await tokens.issue('user-1');
    expect(expiresAt).toEqual(new Date(START.getTime() + 900_000));

    clock.advance(899_000);
    await expect(tokens.verify(token)).resolves.toEqual({ userId: 'user-1' });

    clock.advance(2_000);
    await expect(tokens.verify(token)).resolves.toBeNull();
  });

  it('rejects a token signed with another secret', async () => {
    const { tokens } = setup();
    const other = new AccessTokens(
      { secret: 'another-secret-that-is-also-32-characters-long', ttlSeconds: 900 },
      new FixedClock(START),
    );
    const { token } = await other.issue('user-1');
    await expect(tokens.verify(token)).resolves.toBeNull();
  });

  it('rejects a tampered token', async () => {
    const { tokens } = setup();
    const { token } = await tokens.issue('user-1');
    const [header, , signature] = token.split('.');
    const payload = Buffer.from(JSON.stringify({ sub: 'user-2' })).toString('base64url');
    await expect(tokens.verify(`${header}.${payload}.${signature}`)).resolves.toBeNull();
  });

  it('rejects a correctly signed token that is not an access token', async () => {
    const { tokens } = setup();
    const notAccess = await new SignJWT({ typ: 'refresh' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuedAt(START)
      .setExpirationTime(new Date(START.getTime() + 60_000))
      .sign(new TextEncoder().encode(SECRET));
    await expect(tokens.verify(notAccess)).resolves.toBeNull();
  });

  it('rejects an unsigned token', async () => {
    const { tokens } = setup();
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user-1', typ: 'access' })).toString(
      'base64url',
    );
    await expect(tokens.verify(`${header}.${payload}.`)).resolves.toBeNull();
  });

  it.each(['', 'garbage', 'a.b.c'])('rejects a malformed token (%s)', async (token) => {
    const { tokens } = setup();
    await expect(tokens.verify(token)).resolves.toBeNull();
  });

  it('refuses a secret shorter than 32 characters', () => {
    expect(
      () => new AccessTokens({ secret: 'short', ttlSeconds: 900 }, new FixedClock(START)),
    ).toThrow(/32/);
  });
});
