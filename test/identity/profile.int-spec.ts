import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

interface ProfileBody {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  joinDate: string;
  timezone: string | null;
}

const PROFILE_KEYS = ['avatarUrl', 'bio', 'displayName', 'id', 'joinDate', 'timezone'];

const asProfile = (res: request.Response): ProfileBody => res.body as ProfileBody;
const messageOf = (res: request.Response): string =>
  JSON.stringify((res.body as { message: unknown }).message);

describe('profile (HTTP + PostgreSQL)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
  });

  const http = () => request(app.getHttpServer());

  async function signUp(email: string): Promise<{ token: string; userId: string }> {
    const res = await http()
      .post('/auth/sign-up')
      .send({ email, password: 'correct horse battery staple' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, userId: body.user.id };
  }

  const getProfile = (token: string) =>
    http().get('/me/profile').set('Authorization', `Bearer ${token}`);
  const patchProfile = (token: string, body: object) =>
    http().patch('/me/profile').set('Authorization', `Bearer ${token}`).send(body);

  describe('reading', () => {
    it('returns the profile of a new user, with the join date set by the server', async () => {
      const { token, userId } = await signUp('ada@example.com');

      const profile = asProfile(await getProfile(token).expect(200));

      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(Object.keys(profile).sort()).toEqual(PROFILE_KEYS);
      expect(profile).toEqual({
        id: userId,
        displayName: null,
        avatarUrl: null,
        bio: null,
        joinDate: user.createdAt.toISOString(),
        timezone: null,
      });
    });

    it('requires sign-in', async () => {
      await http().get('/me/profile').expect(401);
      await http().patch('/me/profile').send({ displayName: 'Ada' }).expect(401);
    });

    it('does not expose any route to read another user by id', async () => {
      const ada = await signUp('ada@example.com');
      const grace = await signUp('grace@example.com');
      await http()
        .get(`/users/${grace.userId}/profile`)
        .set('Authorization', `Bearer ${ada.token}`)
        .expect(404);
    });
  });

  describe('updating', () => {
    it('saves display name, bio, and time zone, trimming surrounding whitespace', async () => {
      const { token } = await signUp('ada@example.com');

      const res = await patchProfile(token, {
        displayName: '  Ada Lovelace ',
        bio: ' Counting engines. ',
        timezone: 'Europe/London',
      }).expect(200);

      expect(asProfile(res)).toMatchObject({
        displayName: 'Ada Lovelace',
        bio: 'Counting engines.',
        timezone: 'Europe/London',
      });
      expect(asProfile(await getProfile(token).expect(200))).toMatchObject({
        displayName: 'Ada Lovelace',
        bio: 'Counting engines.',
        timezone: 'Europe/London',
      });
    });

    it('changes only the fields that are sent', async () => {
      const { token } = await signUp('ada@example.com');
      await patchProfile(token, { displayName: 'Ada', bio: 'Engines.' }).expect(200);

      const res = await patchProfile(token, { timezone: 'Asia/Ho_Chi_Minh' }).expect(200);

      expect(asProfile(res)).toMatchObject({
        displayName: 'Ada',
        bio: 'Engines.',
        timezone: 'Asia/Ho_Chi_Minh',
      });
    });

    it.each([null, '', '   '])('clears the bio when it is set to %j', async (bio) => {
      const { token } = await signUp('ada@example.com');
      await patchProfile(token, { bio: 'Engines.' }).expect(200);

      const res = await patchProfile(token, { bio }).expect(200);

      expect(asProfile(res).bio).toBeNull();
    });

    it('never changes the join date', async () => {
      const { token } = await signUp('ada@example.com');
      const before = asProfile(await getProfile(token)).joinDate;

      await patchProfile(token, { displayName: 'Ada' }).expect(200);
      await patchProfile(token, { joinDate: '2001-01-01T00:00:00.000Z' }).expect(400);

      expect(asProfile(await getProfile(token)).joinDate).toBe(before);
    });
  });

  describe('validation', () => {
    it.each([
      ['an empty display name', { displayName: '' }],
      ['a blank display name', { displayName: '   ' }],
      ['a null display name', { displayName: null }],
      ['a display name over 50 characters', { displayName: 'A'.repeat(51) }],
      ['a display name with a line break', { displayName: 'Ada\nLovelace' }],
      ['a non-string display name', { displayName: 42 }],
      ['a bio over 160 characters', { bio: 'B'.repeat(161) }],
      ['a non-string bio', { bio: ['Engines'] }],
    ])('rejects %s', async (_case, body) => {
      const { token } = await signUp('ada@example.com');
      await patchProfile(token, body).expect(400);
      expect(asProfile(await getProfile(token))).toMatchObject({ displayName: null, bio: null });
    });

    it.each(['+07:00', 'GMT+7', 'EST', 'Mars/Olympus', 'asia/ho_chi_minh', '', null, 7])(
      'rejects the time zone %j with a clear message',
      async (timezone) => {
        const { token } = await signUp('ada@example.com');
        const res = await patchProfile(token, { timezone }).expect(400);
        expect(messageOf(res)).toMatch(/IANA time zone/);
        expect(asProfile(await getProfile(token)).timezone).toBeNull();
      },
    );

    it.each([
      ['joinDate', '2001-01-01T00:00:00.000Z'],
      ['id', '00000000-0000-0000-0000-000000000000'],
      ['email', 'someone@example.com'],
      ['avatarUrl', 'https://example.com/a.png'],
      ['status', 'active'],
      ['totalFocusMinutes', 1000],
    ])('rejects the unknown or read-only field %s', async (field, value) => {
      const { token } = await signUp('ada@example.com');
      const res = await patchProfile(token, { displayName: 'Ada', [field]: value }).expect(400);
      expect(messageOf(res)).toContain(field);
      expect(asProfile(await getProfile(token)).displayName).toBeNull();
    });
  });

  describe('ownership', () => {
    it('reads and updates only the signed-in user', async () => {
      const ada = await signUp('ada@example.com');
      const grace = await signUp('grace@example.com');

      await patchProfile(ada.token, { displayName: 'Ada' }).expect(200);
      await patchProfile(grace.token, { displayName: 'Grace' }).expect(200);

      expect(asProfile(await getProfile(ada.token))).toMatchObject({
        id: ada.userId,
        displayName: 'Ada',
      });
      expect(asProfile(await getProfile(grace.token))).toMatchObject({
        id: grace.userId,
        displayName: 'Grace',
      });
    });

    it('ignores any attempt to target another user', async () => {
      const ada = await signUp('ada@example.com');
      const grace = await signUp('grace@example.com');

      await patchProfile(ada.token, { userId: grace.userId, displayName: 'Hacked' }).expect(400);

      expect(asProfile(await getProfile(grace.token)).displayName).toBeNull();
    });
  });
});
