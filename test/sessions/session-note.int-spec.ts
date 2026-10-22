import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { Clock, FixedClock } from '../../src/common/clock.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { ProductConfigService } from '../../src/product-config/product-config.service.js';
import { listenOnLoopback } from '../support/loopback-http.js';
import { configValues } from '../support/product-config-values.js';

type SessionBody = Record<string, unknown> & { id: string; note: string | null; status: string };

const NOW = new Date('2026-09-27T12:00:00.000Z');
const t = (time: string) => `2026-09-27T${time}:00.000Z`;
const asSession = (res: request.Response): SessionBody => res.body as SessionBody;

describe('session note (HTTP + PostgreSQL)', () => {
  let app: INestApplication<App>;
  let url: string;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ cost: 2 ** 10 }))
      .overrideProvider(Clock)
      .useValue(new FixedClock(NOW))
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    url = await listenOnLoopback(app);
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    const config = app.get(ProductConfigService);
    const version = await config.createVersion(configValues(), 'test');
    await config.activate(version.version);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(url);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  interface Account {
    token: string;
    topicId: string;
  }

  async function account(email = 'ada@example.com'): Promise<Account> {
    const res = await http()
      .post('/auth/sign-up')
      .send({ email, password: 'correct horse battery staple' })
      .expect(201);
    const token = (res.body as { accessToken: string }).accessToken;
    await http()
      .patch('/me/profile')
      .set(auth(token))
      .send({ timezone: 'Asia/Ho_Chi_Minh' })
      .expect(200);
    const topicId = randomUUID();
    await http()
      .put(`/me/topics/${topicId}`)
      .set(auth(token))
      .send({ name: 'Reading', icon: 'book', color: 'topic.1' })
      .expect(201);
    return { token, topicId };
  }

  const submission = (topicId: string, endedAt = '10:25') => ({
    topicId,
    startedAt: t('10:00'),
    endedAt: t(endedAt),
    plannedMinutes: 25,
    pauseIntervals: [],
  });

  async function session(who: Account, endedAt = '10:25'): Promise<SessionBody> {
    const res = await http()
      .put(`/me/sessions/${randomUUID()}`)
      .set(auth(who.token))
      .send(submission(who.topicId, endedAt))
      .expect(201);
    return asSession(res);
  }

  const patchNote = (token: string, id: string, payload: object) =>
    http().patch(`/me/sessions/${id}/note`).set(auth(token)).send(payload);

  const storedNote = async (id: string) =>
    (await prisma.focusSession.findFirstOrThrow({ where: { id } })).note;

  describe('setting, replacing, and clearing', () => {
    it('sets a note and answers with the whole session', async () => {
      const ada = await account();
      const created = await session(ada);

      const res = await patchNote(ada.token, created.id, { note: 'Finished chapter 3' }).expect(
        200,
      );

      // The note answer carries the session fields; the growth, progression (A4.2), and event
      // (A5.6) results are only in the submit answer.
      const { growth, progression, events, ...sessionFields } = created as typeof created & {
        growth?: unknown;
        progression?: unknown;
        events?: unknown;
      };
      expect(events).toBeUndefined();
      expect(growth).toMatchObject({ counted: true });
      expect(progression).toMatchObject({ newlyEarnedBadges: [{ id: 'first-session' }] });
      expect(asSession(res)).toStrictEqual({ ...sessionFields, note: 'Finished chapter 3' });
      expect(await storedNote(created.id)).toBe('Finished chapter 3');
    });

    it('replaces a note', async () => {
      const ada = await account();
      const { id } = await session(ada);
      await patchNote(ada.token, id, { note: 'First' }).expect(200);

      const res = await patchNote(ada.token, id, { note: 'Second' }).expect(200);

      expect(asSession(res).note).toBe('Second');
    });

    it.each([null, '', '   \n\t '])('clears the note with %j', async (note) => {
      const ada = await account();
      const { id } = await session(ada);
      await patchNote(ada.token, id, { note: 'Something' }).expect(200);

      const res = await patchNote(ada.token, id, { note }).expect(200);

      expect(asSession(res).note).toBeNull();
      expect(await storedNote(id)).toBeNull();
    });

    it('accepts the same note again', async () => {
      const ada = await account();
      const { id } = await session(ada);
      const first = asSession(await patchNote(ada.token, id, { note: 'Same' }).expect(200));

      const again = asSession(await patchNote(ada.token, id, { note: 'Same' }).expect(200));

      expect(again).toStrictEqual(first);
    });

    it('changes nothing but the note', async () => {
      const ada = await account();
      const { id } = await session(ada);
      const read = () => prisma.focusSession.findFirstOrThrow({ where: { id } });
      const unchangedPart = (row: Awaited<ReturnType<typeof read>>) => ({
        ...row,
        note: 'ignored',
        updatedAt: 'ignored',
      });
      const before = await read();

      await patchNote(ada.token, id, { note: 'Only this' }).expect(200);

      const after = await read();
      expect(unchangedPart(after)).toEqual(unchangedPart(before));
      expect(after.note).toBe('Only this');
    });
  });

  describe('normalization', () => {
    it('trims the outside and keeps inner spaces and line breaks', async () => {
      const ada = await account();
      const { id } = await session(ada);

      const res = await patchNote(ada.token, id, {
        note: '  \n Line one\n\n    indented  line two \t\n',
      }).expect(200);

      expect(asSession(res).note).toBe('Line one\n\n    indented  line two');
    });

    it('stores Unicode NFC', async () => {
      const ada = await account();
      const { id } = await session(ada);
      const res = await patchNote(ada.token, id, { note: 'Đọc sách' }).expect(200);
      expect(asSession(res).note).toBe('Đọc sách');
    });

    it.each([
      ['500 letters', 'a'.repeat(500)],
      ['500 emoji (1000 UTF-16 units)', '🌱'.repeat(500)],
      ['1000 decomposed code points that compose to 500', 'é'.repeat(500)],
      ['500 letters with outer spaces', `  ${'a'.repeat(500)}  `],
    ])('accepts %s', async (_case, note) => {
      const ada = await account();
      const { id } = await session(ada);
      await patchNote(ada.token, id, { note }).expect(200);
      expect([...((await storedNote(id)) ?? '')]).toHaveLength(500);
    });

    it.each([
      ['501 letters', 'a'.repeat(501)],
      ['501 emoji', '🌱'.repeat(501)],
    ])('rejects %s and keeps the note', async (_case, note) => {
      const ada = await account();
      const { id } = await session(ada);
      await patchNote(ada.token, id, { note: 'Kept' }).expect(200);

      await patchNote(ada.token, id, { note }).expect(400);

      expect(await storedNote(id)).toBe('Kept');
    });
  });

  describe('any session can have a note', () => {
    it.each([
      ['completed', '10:25'],
      ['ended_early', '10:15'],
      ['discarded', '10:03'],
    ])('%s', async (status, endedAt) => {
      const ada = await account();
      const created = await session(ada, endedAt);
      expect(created.status).toBe(status);

      const res = await patchNote(ada.token, created.id, { note: 'Noted' }).expect(200);

      expect(asSession(res)).toMatchObject({ status, note: 'Noted' });
    });

    it('whatever the topic status', async () => {
      const ada = await account();
      const { id } = await session(ada);
      await http().post(`/me/topics/${ada.topicId}/archive`).set(auth(ada.token)).expect(200);

      await patchNote(ada.token, id, { note: 'Still mine' }).expect(200);
    });
  });

  describe('ownership', () => {
    it('does not find an unknown session', async () => {
      const ada = await account();
      const res = await patchNote(ada.token, randomUUID(), { note: 'x' }).expect(404);
      expect((res.body as { message: string }).message).toBe('Session not found.');
    });

    it("answers another user's session exactly like a missing one, and leaves it alone", async () => {
      const ada = await account('ada@example.com');
      const grace = await account('grace@example.com');
      const { id } = await session(grace);
      await patchNote(grace.token, id, { note: 'Private' }).expect(200);

      const missing = await patchNote(ada.token, randomUUID(), { note: 'x' }).expect(404);
      const others = await patchNote(ada.token, id, { note: 'x' }).expect(404);

      expect(others.body).toEqual(missing.body);
      expect(await storedNote(id)).toBe('Private');
    });

    it('requires a signed-in user', async () => {
      await http().patch(`/me/sessions/${randomUUID()}/note`).send({ note: 'x' }).expect(401);
    });

    it('rejects a session id that is not a UUID', async () => {
      const ada = await account();
      await patchNote(ada.token, 'not-a-uuid', { note: 'x' }).expect(400);
    });
  });

  describe('request validation', () => {
    it.each([
      ['an empty body, which is not a way to clear', {}],
      ['a number', { note: 42 }],
      ['a list', { note: ['x'] }],
      ['an object', { note: { text: 'x' } }],
    ])('rejects %s and keeps the note', async (_case, payload) => {
      const ada = await account();
      const { id } = await session(ada);
      await patchNote(ada.token, id, { note: 'Kept' }).expect(200);

      await patchNote(ada.token, id, payload).expect(400);

      expect(await storedNote(id)).toBe('Kept');
    });

    it.each([
      ['status', 'completed'],
      ['topicId', randomUUID()],
      ['startedAt', t('09:00')],
      ['endedAt', t('11:00')],
      ['focusedMilliseconds', 1],
      ['counted', true],
      ['localDate', '2026-09-01'],
    ])('refuses to change %s', async (field, value) => {
      const ada = await account();
      const { id } = await session(ada);
      const before = await prisma.focusSession.findFirstOrThrow({ where: { id } });

      await patchNote(ada.token, id, { note: 'x', [field]: value }).expect(400);

      expect(await prisma.focusSession.findFirstOrThrow({ where: { id } })).toEqual(before);
    });
  });

  describe('session replay after a note change', () => {
    it('still replays the original submission, keeps one row, and keeps the note', async () => {
      const ada = await account();
      const id = randomUUID();
      const original = asSession(
        await http()
          .put(`/me/sessions/${id}`)
          .set(auth(ada.token))
          .send(submission(ada.topicId))
          .expect(201),
      );
      await patchNote(ada.token, id, { note: 'Written later' }).expect(200);

      const replay = await http()
        .put(`/me/sessions/${id}`)
        .set(auth(ada.token))
        .send(submission(ada.topicId))
        .expect(200);

      expect(asSession(replay)).toStrictEqual({ ...original, note: 'Written later' });
      expect(await prisma.focusSession.count()).toBe(1);
      expect(await storedNote(id)).toBe('Written later');
    });

    it('still refuses a different submission with the same id', async () => {
      const ada = await account();
      const id = randomUUID();
      await http()
        .put(`/me/sessions/${id}`)
        .set(auth(ada.token))
        .send(submission(ada.topicId))
        .expect(201);
      await patchNote(ada.token, id, { note: 'Written later' }).expect(200);

      const res = await http()
        .put(`/me/sessions/${id}`)
        .set(auth(ada.token))
        .send(submission(ada.topicId, '10:20'))
        .expect(409);

      expect((res.body as { code: string }).code).toBe('session_id_conflict');
    });
  });
});
