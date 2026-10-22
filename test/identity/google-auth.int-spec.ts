import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { Clock, FixedClock } from '../../src/common/clock.js';
import { GoogleIdTokens } from '../../src/identity/google-id-tokens.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { listenOnLoopback } from '../support/loopback-http.js';

/**
 * W.2 Google sign-in (docs/08 §3: an extra sign-in method; users stay in our database). A Google
 * account signs in with the ID token the app got from Google. A new one creates a Focus Forest
 * account (no password; the Google name and the device time zone go to the profile). An email
 * that already has a password account is not taken over: the person signs in with the password.
 * A Google-only account confirms its deletion with Google instead of a password.
 */

const CLIENT = 'web-client.apps.googleusercontent.com';
const PASSWORD = 'correct horse battery staple';

interface AuthBody {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; signInMethod: string };
  created?: boolean;
}

describe('Google sign-in (HTTP + PostgreSQL)', () => {
  let app: INestApplication<App>;
  let url: string;
  let prisma: PrismaService;
  let clock: FixedClock;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    clock = new FixedClock(new Date());
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
    const google = new GoogleIdTokens(
      { clientIds: [CLIENT], keys: createLocalJWKSet({ keys: [jwk] }) },
      clock,
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(clock)
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ cost: 2 ** 10 }))
      .overrideProvider(GoogleIdTokens)
      .useValue(google)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    url = await listenOnLoopback(app);
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    clock.set(new Date());
  });

  const http = () => request(url);
  const idToken = ({
    sub = 'google-ada',
    email = 'ada@gmail.com',
    name = 'Ada Lovelace',
  }: { sub?: string; email?: string; name?: string | null } = {}) =>
    new SignJWT({ email, email_verified: true, ...(name === null ? {} : { name }) })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject(sub)
      .setIssuer('https://accounts.google.com')
      .setAudience(CLIENT)
      .setIssuedAt(clock.now())
      .setExpirationTime(new Date(clock.now().getTime() + 3_600_000))
      .sign(privateKey);
  /** Posts a Google ID token (with these claims) and expects the status. */
  const google = async (status: number, claims = {}, extra: Record<string, unknown> = {}) =>
    http()
      .post('/auth/google')
      .send({ idToken: await idToken(claims), timezone: 'Europe/Zurich', ...extra })
      .expect(status);
  const asAuth = (res: request.Response) => res.body as AuthBody;

  describe('sign in', () => {
    it('creates an account for a new Google account, with its name and the time zone', async () => {
      const res = await google(200);
      const body = asAuth(res);
      expect(body.created).toBe(true);
      expect(body.user).toMatchObject({ email: 'ada@gmail.com', signInMethod: 'google' });
      expect(typeof body.accessToken).toBe('string');

      const user = await prisma.user.findUniqueOrThrow({ where: { id: body.user.id } });
      expect(user).toMatchObject({
        email: 'ada@gmail.com',
        passwordHash: null,
        displayName: 'Ada Lovelace',
        timezone: 'Europe/Zurich',
      });
      const identities = await prisma.userIdentity.findMany({ where: { userId: user.id } });
      expect(identities.map((i) => [i.provider, i.subject])).toEqual([['google', 'google-ada']]);

      // The access token works like any other.
      await http()
        .get('/me/profile')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);
    });

    it('signs the same Google account in again, without touching the profile', async () => {
      const first = asAuth(await google(200));
      await prisma.user.update({ where: { id: first.user.id }, data: { displayName: 'Ada' } });
      const again = asAuth(await google(200, { name: 'Someone Else' }));
      expect(again.created).toBe(false);
      expect(again.user.id).toBe(first.user.id);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: first.user.id } });
      expect(user.displayName).toBe('Ada');
      expect(await prisma.user.count()).toBe(1);
    });

    it('follows the Google account, not its email', async () => {
      const first = asAuth(await google(200));
      const renamed = asAuth(await google(200, { email: 'ada.new@gmail.com' }));
      expect(renamed.user.id).toBe(first.user.id);
    });

    it('never takes over an email that has a password account', async () => {
      await http().post('/auth/sign-up').send({ email: 'ada@gmail.com', password: PASSWORD });
      const res = await google(409);
      expect(res.body).toMatchObject({ code: 'email_has_password' });
      expect(await prisma.userIdentity.count()).toBe(0);
    });

    /** A demo world's account for an email the admin entered: no password, no Google yet. */
    const demoAccount = (email = 'ada@gmail.com', data: Record<string, unknown> = {}) =>
      prisma.user.create({
        data: {
          email,
          passwordHash: null,
          displayName: 'Bill',
          demoAccount: { create: { world: 1, persona: 'main' } },
          ...data,
        },
      });

    it('signs a demo account made for this Gmail in with Google, and keeps it linked', async () => {
      const demo = await demoAccount();
      const first = asAuth(await google(200));
      expect(first.user.id).toBe(demo.id);
      expect(first.created).toBe(false);
      expect(first.user.signInMethod).toBe('google');
      const again = asAuth(await google(200));
      expect(again.user.id).toBe(demo.id);
      expect(await prisma.userIdentity.count()).toBe(1);
      // Its demo history is untouched: still its own name, not Google's.
      expect((await prisma.user.findUniqueOrThrow({ where: { id: demo.id } })).displayName).toBe(
        'Bill',
      );
    });

    it('never links a passwordless account that no demo world made', async () => {
      await prisma.user.create({ data: { email: 'ada@gmail.com', passwordHash: null } });
      const res = await google(409);
      expect(res.body).toMatchObject({ code: 'email_in_use' });
      expect(await prisma.userIdentity.count()).toBe(0);
    });

    it('never links a demo account to a second Google account', async () => {
      const demo = await demoAccount();
      await prisma.userIdentity.create({
        data: { userId: demo.id, provider: 'google', subject: 'google-someone-else' },
      });
      await google(409);
      expect(await prisma.userIdentity.count()).toBe(1);
    });

    it('refuses a token it cannot confirm, and creates nothing', async () => {
      const res = await http()
        .post('/auth/google')
        .send({ idToken: 'not-a-google-token' })
        .expect(401);
      expect((res.body as { message: string }).message).toBe(
        'Google sign-in could not be confirmed.',
      );
      expect(await prisma.user.count()).toBe(0);
    });

    it('keeps a long Google name within the display name limit, and needs no name', async () => {
      const long = asAuth(await google(200, { sub: 'g-long', name: 'A'.repeat(80) }));
      const none = asAuth(await google(200, { sub: 'g-none', email: 'x@gmail.com', name: null }));
      const users = await prisma.user.findMany({
        where: { id: { in: [long.user.id, none.user.id] } },
      });
      const byId = new Map(users.map((u) => [u.id, u.displayName]));
      expect(byId.get(long.user.id)).toHaveLength(50);
      expect(byId.get(none.user.id)).toBeNull();
    });

    it('validates the time zone, and works without one', async () => {
      await google(400, {}, { timezone: 'Mars/Olympus' });
      const res = await http()
        .post('/auth/google')
        .send({ idToken: await idToken() })
        .expect(200);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: asAuth(res).user.id } });
      expect(user.timezone).toBeNull();
    });

    it('refuses a suspended account', async () => {
      const first = asAuth(await google(200));
      await prisma.user.update({ where: { id: first.user.id }, data: { status: 'suspended' } });
      await google(403);
    });

    it('never signs a Google-only account in with a password', async () => {
      await google(200);
      await http()
        .post('/auth/sign-in')
        .send({ email: 'ada@gmail.com', password: PASSWORD })
        .expect(401);
    });

    it('says how each account signs in, also on refresh', async () => {
      const g = asAuth(await google(200));
      const refreshed = await http()
        .post('/auth/refresh')
        .send({ refreshToken: g.refreshToken })
        .expect(200);
      expect(asAuth(refreshed).user.signInMethod).toBe('google');
      const p = await http()
        .post('/auth/sign-up')
        .send({ email: 'ben@example.com', password: PASSWORD })
        .expect(201);
      expect(asAuth(p).user.signInMethod).toBe('password');
    });
  });

  describe('deleting a Google-only account', () => {
    const remove = (auth: AuthBody, body: Record<string, unknown>) =>
      http().delete('/me').set('Authorization', `Bearer ${auth.accessToken}`).send(body);

    it('is confirmed by signing in with the same Google account', async () => {
      const ada = asAuth(await google(200));
      await remove(ada, { googleIdToken: await idToken() }).expect(204);
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.userIdentity.count()).toBe(0);
    });

    it('refuses another Google account, or a password', async () => {
      const ada = asAuth(await google(200));
      const other = await remove(ada, {
        googleIdToken: await idToken({ sub: 'google-ben', email: 'ben@gmail.com' }),
      }).expect(403);
      expect(other.body).toMatchObject({ code: 'google_account_mismatch' });
      const password = await remove(ada, { password: PASSWORD }).expect(403);
      expect(password.body).toMatchObject({ code: 'password_incorrect' });
      expect(await prisma.user.count()).toBe(1);
    });

    it('asks for exactly one confirmation', async () => {
      const ada = asAuth(await google(200));
      await remove(ada, {}).expect(400);
      await remove(ada, { password: PASSWORD, googleIdToken: await idToken() }).expect(400);
    });

    it('lists how the account signs in in the export', async () => {
      const ada = asAuth(await google(200));
      const res = await http()
        .get('/me/export')
        .set('Authorization', `Bearer ${ada.accessToken}`)
        .expect(200);
      const account = (res.body as { account: Record<string, unknown> }).account;
      expect(account['signInMethods']).toEqual(['google']);
      expect(JSON.stringify(res.body)).not.toContain('google-ada');
    });
  });
});
