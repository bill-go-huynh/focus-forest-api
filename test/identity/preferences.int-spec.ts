import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

interface NotificationSetting {
  enabled: boolean;
  time?: string | null;
}

interface PreferencesBody {
  theme: 'system' | 'light' | 'dark';
  sound: boolean;
  haptics: boolean;
  reducedMotion: boolean;
  notifications: Record<string, NotificationSetting>;
}

const off = { enabled: false };
const offTimed = { enabled: false, time: null };

const DEFAULTS: PreferencesBody = {
  theme: 'system',
  sound: true,
  haptics: true,
  reducedMotion: false,
  notifications: {
    dailyGoalReminder: offTimed,
    scheduledFocusReminder: offTimed,
    streakReminder: offTimed,
    eventStart: off,
    eventEndingSoon: off,
    friendInvite: off,
    focusRoomInvite: off,
    challengeUpdate: off,
    badgeUnlocked: off,
    monthlyRecapReady: off,
  },
};

const asPreferences = (res: request.Response): PreferencesBody => res.body as PreferencesBody;
const messageOf = (res: request.Response): string =>
  JSON.stringify((res.body as { message: unknown }).message);

describe('preferences (HTTP + PostgreSQL)', () => {
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

  async function signUp(email = 'ada@example.com'): Promise<string> {
    const res = await http()
      .post('/auth/sign-up')
      .send({ email, password: 'correct horse battery staple' })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  const get = (token: string) =>
    http().get('/me/preferences').set('Authorization', `Bearer ${token}`);
  const patch = (token: string, body: unknown) =>
    http()
      .patch('/me/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  describe('defaults', () => {
    it('gives a new user the documented defaults: system theme, sound and haptics on, every notification off', async () => {
      const token = await signUp();
      expect(asPreferences(await get(token).expect(200))).toEqual(DEFAULTS);
    });

    it('requires sign-in', async () => {
      await http().get('/me/preferences').expect(401);
      await http().patch('/me/preferences').send({ theme: 'dark' }).expect(401);
    });
  });

  describe('display and feedback preferences', () => {
    it.each([
      ['theme', 'dark'],
      ['theme', 'light'],
      ['sound', false],
      ['haptics', false],
      ['reducedMotion', true],
    ])('updates %s on its own, leaving everything else unchanged', async (key, value) => {
      const token = await signUp();

      const res = await patch(token, { [key]: value }).expect(200);

      const expected = { ...DEFAULTS, [key]: value };
      expect(asPreferences(res)).toEqual(expected);
      expect(asPreferences(await get(token))).toEqual(expected);
    });

    it('keeps earlier changes when another preference changes', async () => {
      const token = await signUp();
      await patch(token, { theme: 'dark' }).expect(200);
      await patch(token, { sound: false }).expect(200);

      expect(asPreferences(await get(token))).toMatchObject({ theme: 'dark', sound: false });
    });

    it('accepts an empty update without changing anything', async () => {
      const token = await signUp();
      expect(asPreferences(await patch(token, {}).expect(200))).toEqual(DEFAULTS);
    });

    it.each([
      ['an unknown theme', { theme: 'sepia' }],
      ['a null theme', { theme: null }],
      ['a non-boolean sound', { sound: 'yes' }],
      ['a null haptics', { haptics: null }],
      ['a non-boolean reducedMotion', { reducedMotion: 1 }],
      ['an unknown preference', { fontSize: 'large' }],
      ['a profile field', { displayName: 'Ada' }],
    ])('rejects %s', async (_case, body) => {
      const token = await signUp();
      await patch(token, body).expect(400);
      expect(asPreferences(await get(token))).toEqual(DEFAULTS);
    });
  });

  describe('notification preferences', () => {
    it('enables one category without touching the others', async () => {
      const token = await signUp();

      const res = await patch(token, {
        notifications: { badgeUnlocked: { enabled: true } },
      }).expect(200);

      expect(asPreferences(res).notifications).toEqual({
        ...DEFAULTS.notifications,
        badgeUnlocked: { enabled: true },
      });
    });

    it('stores a user-set time for a reminder, and clears it with null', async () => {
      const token = await signUp();

      await patch(token, {
        notifications: { dailyGoalReminder: { enabled: true, time: '19:30' } },
      }).expect(200);
      expect(asPreferences(await get(token)).notifications['dailyGoalReminder']).toEqual({
        enabled: true,
        time: '19:30',
      });

      await patch(token, { notifications: { dailyGoalReminder: { time: null } } }).expect(200);
      expect(asPreferences(await get(token)).notifications['dailyGoalReminder']).toEqual({
        enabled: true,
        time: null,
      });
    });

    it('changes only the field that is sent within a category', async () => {
      const token = await signUp();
      await patch(token, {
        notifications: { streakReminder: { enabled: true, time: '08:00' } },
      }).expect(200);

      await patch(token, { notifications: { streakReminder: { enabled: false } } }).expect(200);

      expect(asPreferences(await get(token)).notifications['streakReminder']).toEqual({
        enabled: false,
        time: '08:00',
      });
    });

    it('updates display and notification preferences together', async () => {
      const token = await signUp();

      await patch(token, {
        theme: 'dark',
        notifications: { monthlyRecapReady: { enabled: true } },
      }).expect(200);

      const prefs = asPreferences(await get(token));
      expect(prefs.theme).toBe('dark');
      expect(prefs.notifications['monthlyRecapReady']).toEqual({ enabled: true });
    });

    it.each([
      ['an unknown category', { weeklyDigest: { enabled: true } }, 'weeklyDigest'],
      ['a time on a category that has none', { badgeUnlocked: { time: '09:00' } }, 'time'],
      [
        'an unknown field in a category',
        { eventStart: { enabled: true, sound: 'chime' } },
        'sound',
      ],
      ['a non-boolean enabled', { friendInvite: { enabled: 'true' } }, 'enabled'],
      ['a null enabled', { friendInvite: { enabled: null } }, 'enabled'],
      ['a badly formatted time', { dailyGoalReminder: { time: '7:30pm' } }, 'time'],
      ['a category that is not an object', { challengeUpdate: true }, 'challengeUpdate'],
    ])('rejects %s', async (_case, notifications, mention) => {
      const token = await signUp();
      const res = await patch(token, { notifications }).expect(400);
      expect(messageOf(res)).toContain(mention);
      expect(asPreferences(await get(token))).toEqual(DEFAULTS);
    });

    it('rejects notifications that are not an object', async () => {
      const token = await signUp();
      await patch(token, { notifications: ['badgeUnlocked'] }).expect(400);
      await patch(token, { notifications: null }).expect(400);
    });

    it('applies nothing when any part of an update is invalid', async () => {
      const token = await signUp();
      await patch(token, {
        theme: 'dark',
        notifications: { badgeUnlocked: { enabled: true }, weeklyDigest: { enabled: true } },
      }).expect(400);
      expect(asPreferences(await get(token))).toEqual(DEFAULTS);
    });
  });

  describe('ownership', () => {
    it('reads and updates only the signed-in user', async () => {
      const ada = await signUp('ada@example.com');
      const grace = await signUp('grace@example.com');

      await patch(ada, {
        theme: 'dark',
        notifications: { badgeUnlocked: { enabled: true } },
      }).expect(200);

      expect(asPreferences(await get(ada))).toMatchObject({ theme: 'dark' });
      expect(asPreferences(await get(grace))).toEqual(DEFAULTS);
    });

    it('does not accept a user id', async () => {
      const ada = await signUp('ada@example.com');
      const res = await patch(ada, {
        userId: '00000000-0000-0000-0000-000000000000',
        theme: 'dark',
      });
      expect(res.status).toBe(400);
      expect(messageOf(res)).toContain('userId');
    });
  });

  it('deletes preferences together with their user', async () => {
    const token = await signUp();
    await patch(token, {
      theme: 'dark',
      notifications: { badgeUnlocked: { enabled: true } },
    }).expect(200);

    await prisma.user.deleteMany();

    expect(await prisma.userPreferences.count()).toBe(0);
    expect(await prisma.notificationPreference.count()).toBe(0);
  });
});
