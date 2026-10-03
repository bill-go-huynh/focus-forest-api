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

interface ListedTopic {
  id: string;
  name: string;
  status: 'active' | 'archived';
  lastUsedAt: string | null;
  lastPlannedMinutes: number | null;
  [field: string]: unknown;
}

const NOW = new Date('2026-09-27T12:00:00.000Z');
const t = (time: string) => new Date(`2026-09-27T${time}:00.000Z`);
const asTopics = (res: request.Response): ListedTopic[] => res.body as ListedTopic[];
const recentOf = (topic: ListedTopic | undefined) => [topic?.lastUsedAt, topic?.lastPlannedMinutes];

describe('recent topics (HTTP + PostgreSQL)', () => {
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
    const version = await config.createVersion(
      { 'session.minValidMinutes': 5, 'session.maxPauseMinutes': 30 },
      'test',
    );
    await config.activate(version.version);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(url);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function signUp(email = 'ada@example.com'): Promise<string> {
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
    return token;
  }

  async function topic(token: string, name: string, id: string = randomUUID()): Promise<string> {
    await http()
      .put(`/me/topics/${id}`)
      .set(auth(token))
      .send({ name, icon: 'book', color: 'topic.1' })
      .expect(201);
    return id;
  }

  interface SessionSpec {
    start: Date;
    /** Wall-clock length; equal to `planned` (completed) by default. */
    minutes?: number;
    planned?: number;
    id?: string;
  }

  function submit(token: string, topicId: string, spec: SessionSpec) {
    const planned = spec.planned ?? 25;
    const minutes = spec.minutes ?? planned;
    return http()
      .put(`/me/sessions/${spec.id ?? randomUUID()}`)
      .set(auth(token))
      .send({
        topicId,
        startedAt: spec.start.toISOString(),
        endedAt: new Date(spec.start.getTime() + minutes * 60_000).toISOString(),
        plannedMinutes: planned,
        pauseIntervals: [],
      });
  }

  async function session(token: string, topicId: string, spec: SessionSpec): Promise<string> {
    const res = await submit(token, topicId, spec).expect(201);
    return (res.body as { id: string }).id;
  }

  const list = (token: string, query = '') => http().get(`/me/topics${query}`).set(auth(token));
  const listed = async (token: string, query = '') =>
    asTopics(await list(token, query).expect(200));
  const find = async (token: string, id: string, query = '') =>
    (await listed(token, query)).find((item) => item.id === id);

  describe('derived metadata', () => {
    it('is null for a topic that has no session', async () => {
      const token = await signUp();
      const reading = await topic(token, 'Reading');

      expect(recentOf(await find(token, reading))).toEqual([null, null]);
      expect(recentOf(await find(token, reading, '?sort=recent'))).toEqual([null, null]);
    });

    it.each([
      ['completed', 45],
      ['ended_early', 20],
      ['discarded', 3],
    ])('counts a %s session', async (status, minutes) => {
      const token = await signUp();
      const reading = await topic(token, 'Reading');
      const res = await submit(token, reading, { start: t('09:00'), minutes, planned: 45 }).expect(
        201,
      );
      expect((res.body as { status: string }).status).toBe(status);

      expect(recentOf(await find(token, reading))).toEqual(['2026-09-27T09:00:00.000Z', 45]);
    });

    it('is not changed by a rejected submission, which stores nothing', async () => {
      const token = await signUp();
      const reading = await topic(token, 'Reading');
      await session(token, reading, { start: t('08:00'), planned: 25 });

      await submit(token, reading, { start: t('10:00'), minutes: -5, planned: 60 }).expect(422);

      expect(recentOf(await find(token, reading))).toEqual(['2026-09-27T08:00:00.000Z', 25]);
    });
  });

  describe('the latest session', () => {
    it('takes the start and planned minutes of the same, newest session', async () => {
      const token = await signUp();
      const reading = await topic(token, 'Reading');
      // A longer plan earlier: the maximum planned minutes is not the latest.
      await session(token, reading, { start: t('06:00'), planned: 60 });
      await session(token, reading, { start: t('08:00'), planned: 25 });
      await session(token, reading, { start: t('07:10'), planned: 45 });

      expect(recentOf(await find(token, reading))).toEqual(['2026-09-27T08:00:00.000Z', 25]);
    });

    it('lets a newer discarded session override an older completed one', async () => {
      const token = await signUp();
      const reading = await topic(token, 'Reading');
      await session(token, reading, { start: t('06:00'), planned: 25 });
      await session(token, reading, { start: t('08:00'), minutes: 2, planned: 45 });

      expect(recentOf(await find(token, reading))).toEqual(['2026-09-27T08:00:00.000Z', 45]);
    });

    // Sessions that end the moment they start contain no instant, so they may share a start
    // with another session. The highest id is inserted first, then last, so that neither
    // insertion order nor scan direction can pick it by accident.
    it.each([
      ['first', 0],
      ['last', 2],
    ])('breaks a tie on the start by the highest id, inserted %s', async (_case, position) => {
      const token = await signUp();
      const reading = await topic(token, 'Reading');
      const highest = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
      const others = [
        { id: '11111111-1111-4111-8111-111111111111', planned: 25, minutes: 25 },
        { id: '22222222-2222-4222-8222-222222222222', planned: 60, minutes: 0 },
      ];
      const sessions = [...others];
      sessions.splice(position, 0, { id: highest, planned: 45, minutes: 0 });
      for (const spec of sessions) {
        await session(token, reading, { start: t('09:00'), ...spec });
      }

      expect(recentOf(await find(token, reading))).toEqual(['2026-09-27T09:00:00.000Z', 45]);
    });
    // The (user_id, topic_id, started_at, id) index already orders ties by id, so the query
    // must be right without it too: a scan in insertion order returns the first tie it meets.
    it('breaks the tie by id in the query itself, not through the index', async () => {
      const token = await signUp();
      const reading = await topic(token, 'Reading');
      const lowest = { id: '11111111-1111-4111-8111-111111111111', planned: 25, minutes: 0 };
      const highest = { id: 'ffffffff-ffff-4fff-bfff-ffffffffffff', planned: 45, minutes: 0 };
      await session(token, reading, { start: t('09:00'), ...lowest });
      await session(token, reading, { start: t('09:00'), ...highest });

      await prisma.$executeRaw`DROP INDEX focus_sessions_user_id_topic_id_started_at_id_idx`;
      try {
        expect(recentOf(await find(token, reading))).toEqual(['2026-09-27T09:00:00.000Z', 45]);
      } finally {
        await prisma.$executeRaw`CREATE INDEX focus_sessions_user_id_topic_id_started_at_id_idx
          ON focus_sessions (user_id, topic_id, started_at, id)`;
      }
    });
  });

  describe('sort=recent', () => {
    it('lists used topics by latest use, then unused ones in creation order', async () => {
      const token = await signUp();
      const art = await topic(token, 'Art');
      const biology = await topic(token, 'Biology');
      const chess = await topic(token, 'Chess');
      const drums = await topic(token, 'Drums');
      const english = await topic(token, 'English');
      await session(token, biology, { start: t('01:00') });
      await session(token, drums, { start: t('03:00') });
      await session(token, biology, { start: t('02:00') });

      const recent = await listed(token, '?sort=recent');
      const byDefault = await listed(token);

      expect(recent.map((item) => item.id)).toEqual([drums, biology, art, chess, english]);
      expect(byDefault.map((item) => item.id)).toEqual([art, biology, chess, drums, english]);
      expect(recentOf(byDefault[1])).toEqual(['2026-09-27T02:00:00.000Z', 25]);
    });

    it('breaks a tie on the latest use by creation order', async () => {
      const token = await signUp();
      // Ids against creation order, so that ordering by id would give the opposite answer.
      const first = await topic(token, 'First', 'ffffffff-ffff-4fff-bfff-ffffffffffff');
      const second = await topic(token, 'Second', '00000000-0000-4000-8000-000000000000');
      await session(token, second, { start: t('09:00'), minutes: 0 });
      await session(token, first, { start: t('09:00'), minutes: 0 });

      const recent = await listed(token, '?sort=recent');

      expect(recent.map((item) => item.id)).toEqual([first, second]);
    });

    it('keeps to the requested status and keeps metadata on archived topics', async () => {
      const token = await signUp();
      const reading = await topic(token, 'Reading');
      const piano = await topic(token, 'Piano');
      const chess = await topic(token, 'Chess');
      await session(token, piano, { start: t('03:00'), planned: 45 });
      await session(token, reading, { start: t('02:00') });
      await http().post(`/me/topics/${piano}/archive`).set(auth(token)).expect(200);

      const active = await listed(token, '?status=active&sort=recent');
      const archived = await listed(token, '?status=archived&sort=recent');
      const all = await listed(token, '?sort=recent');

      expect(active.map((item) => item.id)).toEqual([reading, chess]);
      expect(archived.map((item) => [item.id, ...recentOf(item)])).toEqual([
        [piano, '2026-09-27T03:00:00.000Z', 45],
      ]);
      expect(all.map((item) => item.id)).toEqual([piano, reading, chess]);
    });
  });

  it("is never affected by another user's sessions, even on a topic with the same id", async () => {
    const ada = await signUp('ada@example.com');
    const grace = await signUp('grace@example.com');
    const shared = randomUUID();
    await topic(ada, 'Reading', shared);
    const adaPiano = await topic(ada, 'Piano');
    await topic(grace, 'Reading', shared);
    await session(ada, adaPiano, { start: t('02:00') });
    await session(grace, shared, { start: t('05:00'), planned: 60 });

    const forAda = await listed(ada, '?sort=recent');

    expect(forAda.map((item) => [item.id, ...recentOf(item)])).toEqual([
      [adaPiano, '2026-09-27T02:00:00.000Z', 25],
      [shared, null, null],
    ]);
  });

  it('survives renaming and archiving, and a note changes nothing', async () => {
    const token = await signUp();
    const reading = await topic(token, 'Reading');
    const id = await session(token, reading, { start: t('09:00'), planned: 45 });
    await http()
      .patch(`/me/topics/${reading}`)
      .set(auth(token))
      .send({ name: 'Books' })
      .expect(200);
    await http()
      .patch(`/me/sessions/${id}/note`)
      .set(auth(token))
      .send({ note: 'Chapter 3' })
      .expect(200);
    await http().post(`/me/topics/${reading}/archive`).set(auth(token)).expect(200);

    expect(recentOf(await find(token, reading))).toEqual(['2026-09-27T09:00:00.000Z', 45]);
  });

  it('gives every topic response the same shape as the list, with the metadata', async () => {
    const token = await signUp();
    const id = randomUUID();
    const create = { name: 'Reading', icon: 'book', color: 'topic.1' };
    await http().put(`/me/topics/${id}`).set(auth(token)).send(create).expect(201);
    await session(token, id, { start: t('09:00'), planned: 45 });
    const metadata = { lastUsedAt: '2026-09-27T09:00:00.000Z', lastPlannedMinutes: 45 };
    const topicAt = `/me/topics/${id}`;

    const responses = [
      await http().put(topicAt).set(auth(token)).send(create).expect(200),
      await http().patch(topicAt).set(auth(token)).send({ name: 'Books' }).expect(200),
      await http().post(`${topicAt}/archive`).set(auth(token)).expect(200),
      await http().post(`${topicAt}/restore`).set(auth(token)).expect(200),
    ];

    for (const res of responses) expect(res.body).toMatchObject(metadata);
    expect(await find(token, id)).toStrictEqual(responses.at(-1)?.body);
  });

  describe('query validation', () => {
    it.each(['?sort=oldest', '?sort=', '?sort=RECENT', '?sort=recent&limit=5', '?order=recent'])(
      'rejects %s',
      async (query) => {
        await list(await signUp(), query).expect(400);
      },
    );
  });
});
