import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { Clock, FixedClock } from '../../src/common/clock.js';
import { CurrentUser, type AuthenticatedUser } from '../../src/identity/current-user.decorator.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

// A protected route that exists only in this test, to exercise the global guard.
@Controller('test-protected')
class ProtectedProbeController {
  @Get()
  whoAmI(@CurrentUser() user: AuthenticatedUser): { userId: string } {
    return { userId: user.userId };
  }
}

interface AuthBody {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: { id: string; email: string };
}

const asAuth = (res: request.Response): AuthBody => res.body as AuthBody;
const messageOf = (res: request.Response): string => (res.body as { message: string }).message;

function expectAuthBody(body: AuthBody, email: string): void {
  expect(typeof body.accessToken).toBe('string');
  expect(typeof body.refreshToken).toBe('string');
  expect(Number.isNaN(Date.parse(body.accessTokenExpiresAt))).toBe(false);
  expect(Number.isNaN(Date.parse(body.refreshTokenExpiresAt))).toBe(false);
  expect(typeof body.user.id).toBe('string');
  expect(body.user.email).toBe(email);
}

const PASSWORD = 'correct horse battery staple';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('auth (HTTP + PostgreSQL)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let clock: FixedClock;
  let output: string[];
  let restoreOutput: () => void;

  beforeAll(async () => {
    output = [];
    const write = (chunk: unknown): boolean => {
      output.push(String(chunk));
      return true;
    };
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(write);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(write);
    restoreOutput = () => {
      stdout.mockRestore();
      stderr.mockRestore();
    };

    clock = new FixedClock(new Date());
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProtectedProbeController],
    })
      .overrideProvider(Clock)
      .useValue(clock)
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ cost: 2 ** 10 }))
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
    restoreOutput();
  });

  beforeEach(() => {
    clock.set(new Date());
  });

  const http = () => request(app.getHttpServer());
  const signUp = (email = 'ada@example.com', password = PASSWORD) =>
    http().post('/auth/sign-up').send({ email, password });

  describe('sign up', () => {
    it('stores the user in our database, with the email normalized and the password hashed', async () => {
      const res = await signUp('  Ada@Example.COM ').expect(201);

      expectAuthBody(asAuth(res), 'ada@example.com');
      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.com' } });
      expect(user.status).toBe('active');
      expect(user.passwordHash).not.toContain(PASSWORD);
    });

    it('refuses an email that is already registered, ignoring case', async () => {
      await signUp('ada@example.com').expect(201);
      const res = await signUp('ADA@example.com').expect(409);
      expect(messageOf(res)).toMatch(/already/i);
    });

    it.each([
      ['an invalid email', { email: 'not-an-email', password: PASSWORD }],
      ['a short password', { email: 'ada@example.com', password: 'short' }],
      ['a missing password', { email: 'ada@example.com' }],
      ['an unexpected field', { email: 'ada@example.com', password: PASSWORD, role: 'admin' }],
    ])('rejects %s without echoing the password', async (_case, body) => {
      const res = await http().post('/auth/sign-up').send(body).expect(400);
      expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
      expect(await prisma.user.count()).toBe(0);
    });
  });

  describe('sign in', () => {
    it('returns tokens for the right email and password', async () => {
      await signUp();
      const res = await http()
        .post('/auth/sign-in')
        .send({ email: 'ADA@example.com', password: PASSWORD })
        .expect(200);
      expectAuthBody(asAuth(res), 'ada@example.com');
    });

    it('gives the same answer for a wrong password and an unknown email', async () => {
      await signUp();
      const wrongPassword = await http()
        .post('/auth/sign-in')
        .send({ email: 'ada@example.com', password: 'not the password' })
        .expect(401);
      const unknownEmail = await http()
        .post('/auth/sign-in')
        .send({ email: 'nobody@example.com', password: PASSWORD })
        .expect(401);
      expect(messageOf(wrongPassword)).toBe(messageOf(unknownEmail));
    });

    it('refuses a suspended user', async () => {
      await signUp();
      await prisma.user.update({
        where: { email: 'ada@example.com' },
        data: { status: 'suspended' },
      });

      const res = await http()
        .post('/auth/sign-in')
        .send({ email: 'ada@example.com', password: PASSWORD })
        .expect(403);
      expect(res.body).not.toHaveProperty('accessToken');
    });
  });

  describe('protected routes', () => {
    it('accepts a valid access token', async () => {
      const body = asAuth(await signUp());
      const res = await http()
        .get('/test-protected')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);
      expect(res.body).toEqual({ userId: body.user.id });
    });

    it.each([
      ['no token', undefined],
      ['a malformed header', 'Token abc'],
      ['a garbage token', 'Bearer abc.def.ghi'],
    ])('rejects %s', async (_case, header) => {
      const req = http().get('/test-protected');
      if (header) req.set('Authorization', header);
      await req.expect(401);
    });

    it('rejects a tampered access token', async () => {
      const body = asAuth(await signUp());
      const token = body.accessToken;
      const tampered = `${token.slice(0, -2)}${token.endsWith('A') ? 'B' : 'A'}${token.slice(-1)}`;
      await http().get('/test-protected').set('Authorization', `Bearer ${tampered}`).expect(401);
    });

    it('rejects an expired access token', async () => {
      const body = asAuth(await signUp());
      clock.advance(16 * MINUTE);
      await http()
        .get('/test-protected')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(401);
    });

    it('rejects the access token of a user who has since been suspended', async () => {
      const body = asAuth(await signUp());
      await prisma.user.update({ where: { id: body.user.id }, data: { status: 'suspended' } });
      await http()
        .get('/test-protected')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(401);
    });

    it('does not accept a refresh token as an access token', async () => {
      const body = asAuth(await signUp());
      await http()
        .get('/test-protected')
        .set('Authorization', `Bearer ${body.refreshToken}`)
        .expect(401);
    });

    it('keeps the health check public', async () => {
      await http().get('/health').expect(200);
    });
  });

  describe('refresh', () => {
    const refresh = (refreshToken: unknown) => http().post('/auth/refresh').send({ refreshToken });

    it('issues a new access token and a new refresh token', async () => {
      const body = asAuth(await signUp());
      clock.advance(16 * MINUTE);

      const res = await refresh(body.refreshToken).expect(200);

      expect(asAuth(res).refreshToken).not.toBe(body.refreshToken);
      await http()
        .get('/test-protected')
        .set('Authorization', `Bearer ${asAuth(res).accessToken}`)
        .expect(200);
    });

    it('stores refresh tokens only as hashes', async () => {
      const body = asAuth(await signUp());
      const stored = await prisma.refreshToken.findMany();
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain(body.refreshToken);
    });

    it('rotates: a refresh token works only once', async () => {
      const body = asAuth(await signUp());
      await refresh(body.refreshToken).expect(200);
      await refresh(body.refreshToken).expect(401);
    });

    it('revokes the whole token family when a used refresh token is replayed', async () => {
      const body = asAuth(await signUp());
      const rotated = await refresh(body.refreshToken).expect(200);

      await refresh(body.refreshToken).expect(401);
      await refresh(asAuth(rotated).refreshToken).expect(401);
    });

    it('is long-lived but expires', async () => {
      const body = asAuth(await signUp());
      clock.advance(29 * DAY);
      const res = await refresh(body.refreshToken).expect(200);

      clock.advance(31 * DAY);
      await refresh(asAuth(res).refreshToken).expect(401);
    });

    it.each([
      ['an unknown token', 'not-a-real-token'],
      ['a missing token', undefined],
    ])('rejects %s', async (_case, token) => {
      const res = await refresh(token);
      expect([400, 401]).toContain(res.status);
    });

    it('refuses a suspended user', async () => {
      const body = asAuth(await signUp());
      await prisma.user.update({ where: { id: body.user.id }, data: { status: 'suspended' } });
      await refresh(body.refreshToken).expect(401);
    });
  });

  it('never writes passwords or tokens to the logs', async () => {
    const body = asAuth(await signUp('log@example.com'));
    await http()
      .post('/auth/sign-in')
      .send({ email: 'log@example.com', password: 'wrong password!' });
    await http().post('/auth/refresh').send({ refreshToken: body.refreshToken });
    await http().post('/auth/refresh').send({ refreshToken: body.refreshToken });
    await http().get('/test-protected').set('Authorization', 'Bearer abc.def.ghi');

    const logs = output.join('');
    for (const secret of [PASSWORD, 'wrong password!', body.accessToken, body.refreshToken]) {
      expect(logs).not.toContain(secret);
    }
    expect(logs).not.toContain(process.env['JWT_ACCESS_SECRET']);
  });
});
