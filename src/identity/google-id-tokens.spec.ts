import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

import { FixedClock } from '../common/clock.js';
import { GoogleIdTokens } from './google-id-tokens.js';

/**
 * W.2 Google sign-in: the API trusts a Google ID token only when Google signed it (its published
 * keys), for one of our OAuth clients, unexpired, and with a verified email.
 */

const CLIENT = 'web-client.apps.googleusercontent.com';
const NOW = new Date('2026-10-18T10:00:00.000Z');

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

describe('GoogleIdTokens', () => {
  let signer: Awaited<ReturnType<typeof keys>>;
  let verifier: GoogleIdTokens;
  beforeAll(async () => {
    signer = await keys();
  });
  beforeEach(() => {
    verifier = new GoogleIdTokens({ clientIds: [CLIENT], keys: signer.jwks }, new FixedClock(NOW));
  });

  const token = (
    claims: Record<string, unknown> = {},
    { audience = CLIENT, issuer = 'https://accounts.google.com', expiresIn = 3600 } = {},
    key = signer.privateKey,
  ) =>
    new SignJWT({ email: 'ada@gmail.com', email_verified: true, name: 'Ada Lovelace', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject('google-sub-1')
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(NOW)
      .setExpirationTime(new Date(NOW.getTime() + expiresIn * 1000))
      .sign(key);

  it('reads the Google account from a valid token', async () => {
    await expect(verifier.verify(await token())).resolves.toEqual({
      subject: 'google-sub-1',
      email: 'ada@gmail.com',
      name: 'Ada Lovelace',
    });
  });

  it('lowercases the email and accepts the short issuer too', async () => {
    const result = await verifier.verify(
      await token({ email: ' Ada@Gmail.COM ' }, { issuer: 'accounts.google.com' }),
    );
    expect(result?.email).toBe('ada@gmail.com');
  });

  it('has no name when Google sent none', async () => {
    const result = await verifier.verify(await token({ name: undefined }));
    expect(result?.name).toBeNull();
  });

  it.each([
    ['another app', { audience: 'someone-else.apps.googleusercontent.com' }, {}],
    ['another issuer', { issuer: 'https://evil.example.com' }, {}],
    ['an expired token', { expiresIn: -60 }, {}],
    ['an unverified email', {}, { email_verified: false }],
    ['no email', {}, { email: undefined }],
  ])('refuses %s', async (_case, options, claims) => {
    await expect(verifier.verify(await token(claims, options))).resolves.toBeNull();
  });

  it('refuses a token signed with a key Google did not publish', async () => {
    const other = await keys();
    await expect(verifier.verify(await token({}, {}, other.privateKey))).resolves.toBeNull();
  });

  it('refuses something that is not a token', async () => {
    await expect(verifier.verify('not-a-token')).resolves.toBeNull();
  });

  it('is off without a configured client', async () => {
    const off = new GoogleIdTokens({ clientIds: [], keys: signer.jwks }, new FixedClock(NOW));
    expect(off.enabled).toBe(false);
    await expect(off.verify(await token())).resolves.toBeNull();
    expect(verifier.enabled).toBe(true);
  });
});
