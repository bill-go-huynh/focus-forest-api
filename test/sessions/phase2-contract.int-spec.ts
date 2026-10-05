import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { Clock, FixedClock } from '../../src/common/clock.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ProductConfigService } from '../../src/product-config/product-config.service.js';
import { listenOnLoopback } from '../support/loopback-http.js';
import { configValues } from '../support/product-config-values.js';

// Invariants that span modules (topics, submission, attribution, history, recent topics) and
// that the per-module suites do not already pin.

type Body = Record<string, unknown>;

const NOW = new Date('2026-09-27T12:00:00.000Z');
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Phase 2 API contract across modules (HTTP + PostgreSQL)', () => {
  let app: INestApplication<App>;
  let url: string;

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

  async function signUp(timezone = 'Asia/Ho_Chi_Minh'): Promise<string> {
    const res = await http()
      .post('/auth/sign-up')
      .send({ email: 'ada@example.com', password: 'correct horse battery staple' })
      .expect(201);
    const token = (res.body as { accessToken: string }).accessToken;
    await http().patch('/me/profile').set(auth(token)).send({ timezone }).expect(200);
    return token;
  }

  const putTopic = (token: string, id: string, name = 'Reading') =>
    http().put(`/me/topics/${id}`).set(auth(token)).send({ name, icon: 'book', color: 'topic.1' });

  const submission = (topicId: string, startedAt: string, minutes = 25) => ({
    topicId,
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(),
    plannedMinutes: 25,
    pauseIntervals: [],
  });

  const putSession = (token: string, id: string, body: object) =>
    http().put(`/me/sessions/${id}`).set(auth(token)).send(body);

  const history = async (token: string) =>
    (await http().get('/me/sessions').set(auth(token)).expect(200)).body as {
      items: Body[];
      nextCursor: string | null;
    };

  const topics = async (token: string, query = '') =>
    (await http().get(`/me/topics${query}`).set(auth(token)).expect(200)).body as Body[];

  it('keeps a session replayable and visible after its topic is archived', async () => {
    const token = await signUp();
    const topicId = randomUUID();
    await putTopic(token, topicId).expect(201);
    const sessionId = randomUUID();
    const body = submission(topicId, '2026-09-27T02:00:00.000Z');
    const created = (await putSession(token, sessionId, body).expect(201)).body as Body;

    await http().post(`/me/topics/${topicId}/archive`).set(auth(token)).expect(200);
    const replay = (await putSession(token, sessionId, body).expect(200)).body as Body;
    const page = await history(token);
    const [archived] = await topics(token, '?status=archived&sort=recent');

    expect(replay).toStrictEqual(created);
    // History items carry the session fields; the growth and progression results (A4.2) are
    // only in the submit answer.
    const { growth, progression, ...sessionFields } = created as Body & {
      growth?: unknown;
      progression?: unknown;
    };
    expect(growth).toMatchObject({ counted: true });
    expect(progression).toMatchObject({ newlyEarnedBadges: [{ id: 'first-session' }] });
    expect(page.items).toStrictEqual([
      {
        ...sessionFields,
        topic: { id: topicId, name: 'Reading', icon: 'book', color: 'topic.1', status: 'archived' },
      },
    ]);
    expect(archived).toMatchObject({
      id: topicId,
      lastUsedAt: '2026-09-27T02:00:00.000Z',
      lastPlannedMinutes: 25,
    });
    expect(await topics(token, '?status=active&sort=recent')).toEqual([]);
  });

  it('keeps the stored day and month, and the recent use, after a time zone change', async () => {
    const token = await signUp('Asia/Ho_Chi_Minh');
    const topicId = randomUUID();
    await putTopic(token, topicId).expect(201);
    // 00:30 on 1 September in Ho Chi Minh City; 13:30 on 31 August in New York.
    const startedAt = '2026-08-31T17:30:00.000Z';
    await putSession(token, randomUUID(), submission(topicId, startedAt)).expect(201);

    await http()
      .patch('/me/profile')
      .set(auth(token))
      .send({ timezone: 'America/New_York' })
      .expect(200);
    const [item] = (await history(token)).items;
    const [topic] = await topics(token, '?sort=recent');

    expect(item).toMatchObject({ startedAt, localDate: '2026-09-01', year: 2026, month: 9 });
    expect(topic).toMatchObject({ lastUsedAt: startedAt, lastPlannedMinutes: 25 });
  });

  it('answers with lowercase ids whatever the casing sent, and replays across casings', async () => {
    const token = await signUp();
    const topicId = randomUUID();
    const sessionId = randomUUID();
    const upper = (id: string) => id.toUpperCase();

    const topic = (await putTopic(token, upper(topicId)).expect(201)).body as Body;
    await putTopic(token, topicId).expect(200);
    const body = submission(upper(topicId), '2026-09-27T02:00:00.000Z');
    const created = (await putSession(token, upper(sessionId), body).expect(201)).body as Body;
    // The retry resends the same body, with the id in another casing.
    const replay = await putSession(token, sessionId, body).expect(200);
    const noted = await http()
      .patch(`/me/sessions/${upper(sessionId)}/note`)
      .set(auth(token))
      .send({ note: 'Done' })
      .expect(200);
    const [item] = (await history(token)).items;

    expect(topic['id']).toBe(topicId);
    expect(created).toMatchObject({ id: sessionId, topicId });
    expect(replay.body).toStrictEqual(created);
    expect((noted.body as Body)['id']).toBe(sessionId);
    expect(item).toMatchObject({ id: sessionId, topicId, topic: { id: topicId } });
    for (const id of [topic['id'], created['id'], created['topicId']]) {
      expect(id).toMatch(LOWERCASE_UUID);
    }
  });
});
