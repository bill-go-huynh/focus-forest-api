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
import { listenOnLoopback } from '../support/loopback-http.js';

interface TopicBody {
  id: string;
  name: string;
  icon: string;
  color: string;
  description: string | null;
  status: 'active' | 'archived';
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  lastPlannedMinutes: number | null;
}

const NOW = new Date('2026-09-27T10:00:00.000Z');
const reading = { name: 'Reading', icon: 'book', color: 'topic.1' };

const asTopic = (res: request.Response): TopicBody => res.body as TopicBody;
const asTopics = (res: request.Response): TopicBody[] => res.body as TopicBody[];
const codeOf = (res: request.Response): unknown => (res.body as { code?: unknown }).code;
const messageOf = (res: request.Response): string =>
  JSON.stringify((res.body as { message: unknown }).message);

describe('topics (HTTP + PostgreSQL)', () => {
  let app: INestApplication<App>;
  let url: string;
  let prisma: PrismaService;
  let clock: FixedClock;

  beforeAll(async () => {
    clock = new FixedClock(NOW);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ cost: 2 ** 10 }))
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    url = await listenOnLoopback(app);
    prisma = app.get(PrismaService);
  });

  beforeEach(() => {
    clock.set(NOW);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(url);

  async function signUp(email = 'ada@example.com'): Promise<string> {
    const res = await http()
      .post('/auth/sign-up')
      .send({ email, password: 'correct horse battery staple' })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const put = (token: string, id: string, body: object) =>
    http().put(`/me/topics/${id}`).set(auth(token)).send(body);
  const patch = (token: string, id: string, body: object) =>
    http().patch(`/me/topics/${id}`).set(auth(token)).send(body);
  const archive = (token: string, id: string) =>
    http().post(`/me/topics/${id}/archive`).set(auth(token));
  const restore = (token: string, id: string) =>
    http().post(`/me/topics/${id}/restore`).set(auth(token));
  const list = (token: string, query = '') => http().get(`/me/topics${query}`).set(auth(token));

  async function create(token: string, body: object = reading): Promise<TopicBody> {
    return asTopic(await put(token, randomUUID(), body).expect(201));
  }

  describe('authentication', () => {
    it('requires a signed-in user on every route', async () => {
      const id = randomUUID();
      await http().get('/me/topics').expect(401);
      await http().put(`/me/topics/${id}`).send(reading).expect(401);
      await http().patch(`/me/topics/${id}`).send({ name: 'X' }).expect(401);
      await http().post(`/me/topics/${id}/archive`).expect(401);
      await http().post(`/me/topics/${id}/restore`).expect(401);
    });
  });

  describe('creating (PUT /me/topics/:id)', () => {
    it('creates an active topic with the client-generated id', async () => {
      const token = await signUp();
      const id = randomUUID();

      const res = await put(token, id, { ...reading, description: 'Novels' }).expect(201);

      expect(asTopic(res)).toStrictEqual({
        id,
        name: 'Reading',
        icon: 'book',
        color: 'topic.1',
        description: 'Novels',
        status: 'active',
        archivedAt: null,
        createdAt: expect.any(String) as string,
        updatedAt: expect.any(String) as string,
        lastUsedAt: null,
        lastPlannedMinutes: null,
      });
      expect(asTopics(await list(token).expect(200))).toEqual([asTopic(res)]);
    });

    it('trims the name and description and stores one Unicode form', async () => {
      const token = await signUp();

      const topic = await create(token, {
        ...reading,
        name: '  Đọc sách ',
        description: '  Novels  ',
      });

      expect(topic.name).toBe('Đọc sách');
      expect(topic.description).toBe('Novels');
    });

    it.each([null, '', '   ', undefined])(
      'stores a %j description as null',
      async (description) => {
        const token = await signUp();
        const topic = await create(token, { ...reading, description });
        expect(topic.description).toBeNull();
      },
    );

    it('accepts a name of exactly 100 characters, counting emoji as one each', async () => {
      const token = await signUp();
      const name = '🌱'.repeat(100);
      expect((await create(token, { ...reading, name })).name).toBe(name);
    });

    describe('idempotency', () => {
      it('replays the same request without creating a second topic', async () => {
        const token = await signUp();
        const id = randomUUID();
        const first = asTopic(await put(token, id, reading).expect(201));

        const again = await put(token, id, reading).expect(200);

        expect(asTopic(again)).toStrictEqual(first);
        expect(await prisma.topic.count()).toBe(1);
      });

      it('treats payloads that are equal after trimming as the same request', async () => {
        const token = await signUp();
        const id = randomUUID();
        await put(token, id, { ...reading, description: null }).expect(201);

        await put(token, id, { ...reading, name: ' Reading ', description: '  ' }).expect(200);

        expect(await prisma.topic.count()).toBe(1);
      });

      it('answers a late replay with the topic as it is now, even after later changes', async () => {
        const token = await signUp();
        const id = randomUUID();
        await put(token, id, reading).expect(201);
        await patch(token, id, { name: 'Books' }).expect(200);
        await archive(token, id).expect(200);

        const replay = await put(token, id, reading).expect(200);

        expect(asTopic(replay)).toMatchObject({ id, name: 'Books', status: 'archived' });
        expect(await prisma.topic.count()).toBe(1);
      });

      it.each([
        ['name', { name: 'Writing' }],
        ['icon', { icon: 'pen' }],
        ['color', { color: 'topic.2' }],
        ['description', { description: 'Novels' }],
      ])('refuses the same id with a different %s', async (_field, change) => {
        const token = await signUp();
        const id = randomUUID();
        const first = asTopic(await put(token, id, reading).expect(201));

        const res = await put(token, id, { ...reading, ...change }).expect(409);

        expect(codeOf(res)).toBe('topic_id_conflict');
        expect(asTopics(await list(token))).toEqual([first]);
      });

      it('creates exactly one topic when the same request arrives concurrently', async () => {
        const token = await signUp();
        const id = randomUUID();

        const responses = await Promise.all(
          Array.from({ length: 5 }, () => put(token, id, reading)),
        );

        expect(responses.map((res) => res.status).sort()).toEqual([200, 200, 200, 200, 201]);
        expect(await prisma.topic.count()).toBe(1);
      });
    });

    describe('active-name uniqueness', () => {
      it.each([
        ['the same name', 'Reading'],
        ['different case', 'rEADING'],
        ['surrounding spaces', '  Reading  '],
        ['Vietnamese capitals', 'ĐỌC SÁCH'],
        ['combining marks', 'đọc sách'],
      ])('refuses %s as another active topic', async (_case, name) => {
        const token = await signUp();
        await create(token, reading);
        await create(token, { ...reading, name: 'Đọc sách' });

        const res = await put(token, randomUUID(), { ...reading, name }).expect(409);

        expect(codeOf(res)).toBe('topic_name_taken');
        expect(messageOf(res)).toContain('That name is already used by another topic.');
        expect(await prisma.topic.count()).toBe(2);
      });

      it('lets different users use the same name', async () => {
        await create(await signUp('ada@example.com'), reading);
        await create(await signUp('grace@example.com'), reading);
        expect(await prisma.topic.count()).toBe(2);
      });

      it('frees the name of an archived topic', async () => {
        const token = await signUp();
        const old = await create(token, reading);
        await archive(token, old.id).expect(200);

        const fresh = await create(token, { ...reading, name: 'reading' });

        expect(fresh.status).toBe('active');
      });

      it('lets only one of two concurrent creates take a name', async () => {
        const token = await signUp();

        const responses = await Promise.all([
          put(token, randomUUID(), reading),
          put(token, randomUUID(), { ...reading, name: 'READING' }),
        ]);

        expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
        expect(await prisma.topic.count()).toBe(1);
      });
    });

    describe('validation', () => {
      it.each([
        ['no name', { icon: 'book', color: 'topic.1' }],
        ['an empty name', { ...reading, name: '' }],
        ['a blank name', { ...reading, name: '   ' }],
        ['a null name', { ...reading, name: null }],
        ['a non-string name', { ...reading, name: 42 }],
        ['a name over 100 characters', { ...reading, name: 'A'.repeat(101) }],
        ['101 emoji', { ...reading, name: '🌱'.repeat(101) }],
        ['no icon', { name: 'Reading', color: 'topic.1' }],
        ['an icon that is not an identifier', { ...reading, icon: 'Book Icon' }],
        ['a path as icon', { ...reading, icon: '../book' }],
        ['no color', { name: 'Reading', icon: 'book' }],
        ['a free color', { ...reading, color: '#3B7349' }],
        ['topic.0', { ...reading, color: 'topic.0' }],
        ['topic.13', { ...reading, color: 'topic.13' }],
        ['a description over 500 characters', { ...reading, description: 'D'.repeat(501) }],
        ['a non-string description', { ...reading, description: ['Novels'] }],
      ])('rejects %s', async (_case, body) => {
        const token = await signUp();
        await put(token, randomUUID(), body).expect(400);
        expect(await prisma.topic.count()).toBe(0);
      });

      it.each([
        ['status', 'archived'],
        ['archivedAt', '2026-01-01T00:00:00.000Z'],
        ['userId', '00000000-0000-0000-0000-000000000000'],
        ['id', '00000000-0000-0000-0000-000000000000'],
        ['totalFocusMinutes', 60],
      ])('rejects the unknown or read-only field %s', async (field, value) => {
        const token = await signUp();
        const res = await put(token, randomUUID(), { ...reading, [field]: value }).expect(400);
        expect(messageOf(res)).toContain(field);
        expect(await prisma.topic.count()).toBe(0);
      });

      it.each(['not-a-uuid', '123', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'])(
        'rejects the id %s',
        async (id) => {
          const token = await signUp();
          await put(token, id, reading).expect(400);
          expect(await prisma.topic.count()).toBe(0);
        },
      );
    });
  });

  describe('listing (GET /me/topics)', () => {
    it('lists active and archived topics in creation order, or one status', async () => {
      const token = await signUp();
      const first = await create(token, reading);
      clock.advance(1000);
      const second = await create(token, { ...reading, name: 'Piano' });
      await archive(token, first.id).expect(200);

      const all = asTopics(await list(token).expect(200));
      const active = asTopics(await list(token, '?status=active').expect(200));
      const archived = asTopics(await list(token, '?status=archived').expect(200));

      expect(all.map((topic) => topic.id)).toEqual([first.id, second.id]);
      expect(active.map((topic) => topic.id)).toEqual([second.id]);
      expect(archived.map((topic) => topic.id)).toEqual([first.id]);
    });

    it('returns an empty list before any topic exists', async () => {
      expect(asTopics(await list(await signUp()).expect(200))).toEqual([]);
    });

    it.each(['?status=deleted', '?status=', '?limit=5'])('rejects the query %s', async (query) => {
      await list(await signUp(), query).expect(400);
    });
  });

  describe('editing (PATCH /me/topics/:id)', () => {
    it('changes only the fields that are sent, trimming text', async () => {
      const token = await signUp();
      const topic = await create(token, { ...reading, description: 'Novels' });

      const res = await patch(token, topic.id, { name: ' Books ', color: 'topic.4' }).expect(200);

      expect(asTopic(res)).toMatchObject({
        name: 'Books',
        icon: 'book',
        color: 'topic.4',
        description: 'Novels',
      });
      expect(asTopics(await list(token))[0]).toEqual(asTopic(res));
    });

    it.each([null, '', '   '])(
      'clears the description when it is set to %j',
      async (description) => {
        const token = await signUp();
        const topic = await create(token, { ...reading, description: 'Novels' });
        const res = await patch(token, topic.id, { description }).expect(200);
        expect(asTopic(res).description).toBeNull();
      },
    );

    it('lets a topic change the case of its own name', async () => {
      const token = await signUp();
      const topic = await create(token, reading);
      const res = await patch(token, topic.id, { name: 'READING' }).expect(200);
      expect(asTopic(res).name).toBe('READING');
    });

    it('refuses a name another active topic uses', async () => {
      const token = await signUp();
      await create(token, reading);
      const piano = await create(token, { ...reading, name: 'Piano' });

      const res = await patch(token, piano.id, { name: 'reading' }).expect(409);

      expect(codeOf(res)).toBe('topic_name_taken');
      expect(asTopics(await list(token, '?status=active')).map((t) => t.name)).toEqual([
        'Reading',
        'Piano',
      ]);
    });

    it('edits an archived topic, whose name does not count as taken', async () => {
      const token = await signUp();
      await create(token, reading);
      const old = await create(token, { ...reading, name: 'Old reading' });
      await archive(token, old.id).expect(200);

      const res = await patch(token, old.id, { name: 'Reading' }).expect(200);

      expect(asTopic(res)).toMatchObject({ name: 'Reading', status: 'archived' });
    });

    it.each([
      ['an empty name', { name: '' }],
      ['a null name', { name: null }],
      ['a name over 100 characters', { name: 'A'.repeat(101) }],
      ['a null icon', { icon: null }],
      ['a bad icon', { icon: 'Book' }],
      ['a null color', { color: null }],
      ['a bad color', { color: 'topic.13' }],
      ['a description over 500 characters', { description: 'D'.repeat(501) }],
      ['a status change', { status: 'archived' }],
      ['an archive date', { archivedAt: '2026-01-01T00:00:00.000Z' }],
    ])('rejects %s', async (_case, body) => {
      const token = await signUp();
      const topic = await create(token, reading);
      await patch(token, topic.id, body).expect(400);
      expect(asTopics(await list(token))[0]).toEqual(topic);
    });

    it('does not find an unknown id', async () => {
      await patch(await signUp(), randomUUID(), { name: 'Books' }).expect(404);
    });
  });

  describe('archiving and restoring', () => {
    it('archives with the current time and keeps the topic', async () => {
      const token = await signUp();
      const topic = await create(token, reading);
      // Within the access token's lifetime.
      clock.set(new Date('2026-09-27T10:05:30.000Z'));

      const res = await archive(token, topic.id).expect(200);

      expect(asTopic(res)).toMatchObject({
        id: topic.id,
        name: 'Reading',
        status: 'archived',
        archivedAt: '2026-09-27T10:05:30.000Z',
      });
      expect(await prisma.topic.count()).toBe(1);
    });

    it('archiving twice keeps the first archive time', async () => {
      const token = await signUp();
      const topic = await create(token, reading);
      await archive(token, topic.id).expect(200);
      clock.advance(60_000);

      const res = await archive(token, topic.id).expect(200);

      expect(asTopic(res).archivedAt).toBe(NOW.toISOString());
    });

    it('restores an archived topic, and restoring an active one changes nothing', async () => {
      const token = await signUp();
      const topic = await create(token, reading);
      await archive(token, topic.id).expect(200);

      const restored = asTopic(await restore(token, topic.id).expect(200));
      const again = asTopic(await restore(token, topic.id).expect(200));

      expect(restored).toMatchObject({ status: 'active', archivedAt: null });
      expect(again).toStrictEqual(restored);
    });

    it('refuses to restore while another active topic has the name', async () => {
      const token = await signUp();
      const old = await create(token, reading);
      await archive(token, old.id).expect(200);
      await create(token, { ...reading, name: 'READING' });

      const res = await restore(token, old.id).expect(409);

      expect(codeOf(res)).toBe('topic_name_taken');
      expect(asTopics(await list(token, '?status=archived')).map((t) => t.id)).toEqual([old.id]);
    });

    it('does not find an unknown id', async () => {
      const token = await signUp();
      await archive(token, randomUUID()).expect(404);
      await restore(token, randomUUID()).expect(404);
    });

    it('has no way to delete a topic', async () => {
      const token = await signUp();
      const topic = await create(token, reading);
      await http().delete(`/me/topics/${topic.id}`).set(auth(token)).expect(404);
      expect(await prisma.topic.count()).toBe(1);
    });

    it('never stores an archived topic without its archive time, or the reverse', async () => {
      const token = await signUp();
      const topic = await create(token, reading);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE topics SET status = 'archived' WHERE id = '${topic.id}'`),
      ).rejects.toThrow();
      await expect(
        prisma.$executeRawUnsafe(`UPDATE topics SET archived_at = now() WHERE id = '${topic.id}'`),
      ).rejects.toThrow();
    });
  });

  describe('ownership', () => {
    it("never shows or changes another user's topic", async () => {
      const ada = await signUp('ada@example.com');
      const grace = await signUp('grace@example.com');
      const topic = await create(ada, reading);

      expect(asTopics(await list(grace))).toEqual([]);
      await patch(grace, topic.id, { name: 'Mine' }).expect(404);
      await archive(grace, topic.id).expect(404);
      await restore(grace, topic.id).expect(404);

      expect(asTopics(await list(ada))).toEqual([topic]);
    });

    it("gives no sign that another user's id exists when it is reused", async () => {
      const ada = await signUp('ada@example.com');
      const grace = await signUp('grace@example.com');
      const adas = await create(ada, reading);

      const res = await put(grace, adas.id, { ...reading, name: 'Piano' }).expect(201);

      expect(asTopic(res)).toMatchObject({ id: adas.id, name: 'Piano' });
      expect(asTopics(await list(ada))).toEqual([adas]);
      expect(asTopics(await list(grace)).map((t) => t.name)).toEqual(['Piano']);
    });
  });
});
