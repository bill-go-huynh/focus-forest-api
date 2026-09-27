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
import { evaluateSession } from '../../src/sessions/evaluation/evaluate-session.js';

interface SessionBody {
  id: string;
  topicId: string;
  startedAt: string;
  endedAt: string;
  plannedMinutes: number;
  focusedMilliseconds: number;
  pausedMilliseconds: number;
  status: 'completed' | 'ended_early' | 'discarded';
  counted: boolean;
  localDate: string;
  year: number;
  month: number;
  note: string | null;
  createdAt: string;
}

const MINUTE = 60_000;
const NOW = new Date('2026-09-27T12:00:00.000Z');
/** "10:30" → that time on 27 September 2026, UTC, as an ISO string. */
const t = (time: string) =>
  `2026-09-27T${time.length === 5 ? `${time}:00.000` : time.includes('.') ? time : `${time}.000`}Z`;
const pause = (start: string, end: string) => ({ startedAt: t(start), endedAt: t(end) });

const asSession = (res: request.Response): SessionBody => res.body as SessionBody;
const codeOf = (res: request.Response): unknown => (res.body as { code?: unknown }).code;
const messageOf = (res: request.Response): string =>
  JSON.stringify((res.body as { message: unknown }).message);

describe('focus sessions (HTTP + PostgreSQL)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let config: ProductConfigService;
  let configVersion: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ cost: 2 ** 10 }))
      .overrideProvider(Clock)
      .useValue(new FixedClock(NOW))
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    config = app.get(ProductConfigService);
  });

  // Every test starts with empty tables, including configuration.
  beforeEach(async () => {
    configVersion = await activateRules(5, 30);
  });

  afterAll(async () => {
    await app.close();
  });

  async function activateRules(minValidMinutes: number, maxPauseMinutes: number) {
    const created = await config.createVersion(
      { 'session.minValidMinutes': minValidMinutes, 'session.maxPauseMinutes': maxPauseMinutes },
      'test',
    );
    await config.activate(created.version);
    return created.version;
  }

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  interface Account {
    token: string;
    topicId: string;
  }

  async function account(
    email = 'ada@example.com',
    timezone: string | null = 'Asia/Ho_Chi_Minh',
  ): Promise<Account> {
    const res = await http()
      .post('/auth/sign-up')
      .send({ email, password: 'correct horse battery staple' })
      .expect(201);
    const token = (res.body as { accessToken: string }).accessToken;
    if (timezone) await http().patch('/me/profile').set(auth(token)).send({ timezone }).expect(200);
    const topicId = randomUUID();
    await http()
      .put(`/me/topics/${topicId}`)
      .set(auth(token))
      .send({ name: 'Reading', icon: 'book', color: 'topic.1' })
      .expect(201);
    return { token, topicId };
  }

  function body(topicId: string, overrides: object = {}) {
    return {
      topicId,
      startedAt: t('10:00'),
      endedAt: t('10:25'),
      plannedMinutes: 25,
      pauseIntervals: [],
      ...overrides,
    };
  }

  const put = (token: string, id: string, payload: object) =>
    http().put(`/me/sessions/${id}`).set(auth(token)).send(payload);

  async function submit(who: Account, overrides: object = {}, id = randomUUID()) {
    return asSession(await put(who.token, id, body(who.topicId, overrides)).expect(201));
  }

  const sessionCount = () => prisma.focusSession.count();
  const contextCount = () => prisma.monthAttributionContext.count();

  describe('creating', () => {
    it('stores a completed session with everything the server derives', async () => {
      const ada = await account();
      const id = randomUUID();

      const res = await put(ada.token, id, body(ada.topicId)).expect(201);

      expect(asSession(res)).toStrictEqual({
        id,
        topicId: ada.topicId,
        startedAt: t('10:00'),
        endedAt: t('10:25'),
        plannedMinutes: 25,
        focusedMilliseconds: 25 * MINUTE,
        pausedMilliseconds: 0,
        status: 'completed',
        counted: true,
        localDate: '2026-09-27',
        year: 2026,
        month: 9,
        note: null,
        createdAt: expect.any(String) as string,
      });
      const row = await prisma.focusSession.findFirstOrThrow();
      expect(row.configVersion).toBe(configVersion);
      expect(row.submittedEndedAt).toEqual(new Date(t('10:25')));
    });

    it('stores an early end above the minimum as counted', async () => {
      const session = await submit(await account(), { endedAt: t('10:12') });
      expect(session).toMatchObject({ endedAt: t('10:12'), status: 'ended_early', counted: true });
    });

    it('stores a session below the minimum as discarded, not counted', async () => {
      const session = await submit(await account(), { endedAt: t('10:03') });
      expect(session).toMatchObject({
        focusedMilliseconds: 3 * MINUTE,
        status: 'discarded',
        counted: false,
      });
      expect(await sessionCount()).toBe(1);
    });

    it('accepts a session for an archived topic', async () => {
      const ada = await account();
      await http().post(`/me/topics/${ada.topicId}/archive`).set(auth(ada.token)).expect(200);
      expect((await submit(ada)).status).toBe('completed');
    });

    it('attributes the day and month from the start in the user time zone', async () => {
      // 23:50 on 31 August in Ho Chi Minh City, ending the next day and month.
      const ada = await account();
      const session = await submit(ada, {
        startedAt: '2026-08-31T16:50:00.000Z',
        endedAt: '2026-08-31T17:15:00.000Z',
      });
      expect(session).toMatchObject({ localDate: '2026-08-31', year: 2026, month: 8 });
    });

    it('derives focused and paused time exactly as the evaluator, with the server pause limit', async () => {
      await activateRules(5, 20);
      const ada = await account();
      const payload = body(ada.topicId, {
        plannedMinutes: 60,
        endedAt: t('11:30'),
        pauseIntervals: [pause('10:05', '10:10'), pause('10:20', '10:50')],
      });

      const session = asSession(await put(ada.token, randomUUID(), payload).expect(201));

      const expected = evaluateSession(
        {
          startedAt: new Date(t('10:00')),
          endedAt: new Date(t('11:30')),
          plannedMinutes: 60,
          pauses: [
            { startedAt: new Date(t('10:05')), endedAt: new Date(t('10:10')) },
            { startedAt: new Date(t('10:20')), endedAt: new Date(t('10:50')) },
          ],
        },
        { minValidMinutes: 5, maxPauseMinutes: 20 },
        NOW,
      );
      expect(expected.kind).toBe('accepted');
      if (expected.kind !== 'accepted') return;
      expect(session).toMatchObject({
        endedAt: expected.effectiveEnd.toISOString(), // 10:35, when the 20-minute limit is reached
        focusedMilliseconds: expected.focusedMilliseconds,
        pausedMilliseconds: expected.pausedMilliseconds,
        status: expected.status,
      });
      expect(session.endedAt).toBe(t('10:35'));
    });
  });

  describe('rejections (422)', () => {
    it.each([
      ['invalid_time', { startedAt: '2026-09-27T10:00:00' }], // no offset: ambiguous
      ['invalid_time', { endedAt: 'not a date' }],
      ['invalid_planned_duration', { plannedMinutes: 0 }],
      ['invalid_planned_duration', { plannedMinutes: 1441 }],
      ['invalid_planned_duration', { plannedMinutes: 2.5 }],
      ['ends_before_start', { endedAt: t('09:59') }],
      ['ends_in_future', { startedAt: t('11:50'), endedAt: t('12:02:00.001') }],
      ['pause_ends_before_start', { pauseIntervals: [pause('10:10', '10:05')] }],
      ['pause_outside_session', { pauseIntervals: [pause('09:55', '10:05')] }],
      [
        'pauses_out_of_order',
        { pauseIntervals: [pause('10:10', '10:11'), pause('10:02', '10:03')] },
      ],
      ['pauses_overlap', { pauseIntervals: [pause('10:02', '10:06'), pause('10:05', '10:08')] }],
    ])('answers %s and stores nothing', async (code, overrides) => {
      const ada = await account();

      const res = await put(ada.token, randomUUID(), body(ada.topicId, overrides)).expect(422);

      expect(codeOf(res)).toBe(code);
      expect(await sessionCount()).toBe(0);
      expect(await contextCount()).toBe(0);
    });

    it('answers timezone_required when the profile has no time zone, and stores nothing', async () => {
      const ada = await account('ada@example.com', null);

      const res = await put(ada.token, randomUUID(), body(ada.topicId)).expect(422);

      expect(codeOf(res)).toBe('timezone_required');
      expect(await sessionCount()).toBe(0);
      expect(await contextCount()).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('replays the same submission with 200 and the stored result, without a second row', async () => {
      const ada = await account();
      const id = randomUUID();
      const first = asSession(await put(ada.token, id, body(ada.topicId)).expect(201));

      const again = await put(ada.token, id, body(ada.topicId)).expect(200);

      expect(asSession(again)).toStrictEqual(first);
      expect(await sessionCount()).toBe(1);
    });

    it('replays a session whose submitted end was later than its completion', async () => {
      const ada = await account();
      const id = randomUUID();
      const payload = body(ada.topicId, { endedAt: t('11:40') });
      const first = asSession(await put(ada.token, id, payload).expect(201));
      expect(first.endedAt).toBe(t('10:25'));

      expect(asSession(await put(ada.token, id, payload).expect(200))).toStrictEqual(first);
    });

    it('treats the same instants written with another offset as the same submission', async () => {
      const ada = await account();
      const id = randomUUID();
      await put(ada.token, id, body(ada.topicId)).expect(201);

      await put(
        ada.token,
        id,
        body(ada.topicId, {
          startedAt: '2026-09-27T17:00:00+07:00',
          endedAt: '2026-09-27T17:25:00+07:00',
        }),
      ).expect(200);
    });

    it('replays the original result after the configuration changes, and new sessions use the new one', async () => {
      const ada = await account();
      const id = randomUUID();
      const first = asSession(
        await put(ada.token, id, body(ada.topicId, { endedAt: t('10:20') })).expect(201),
      );
      expect(first).toMatchObject({ status: 'ended_early', counted: true });
      const newVersion = await activateRules(30, 10);

      const replay = await put(ada.token, id, body(ada.topicId, { endedAt: t('10:20') })).expect(
        200,
      );

      expect(asSession(replay)).toStrictEqual(first);
      expect((await prisma.focusSession.findFirstOrThrow()).configVersion).toBe(configVersion);

      const next = await submit(ada, { startedAt: t('11:00'), endedAt: t('11:20') });
      expect(next).toMatchObject({ status: 'discarded', counted: false });
      const stored = await prisma.focusSession.findMany({ orderBy: { startedAt: 'asc' } });
      expect(stored.map((row) => row.configVersion)).toEqual([configVersion, newVersion]);
    });

    it.each([
      ['start', { startedAt: t('10:01') }],
      ['end', { endedAt: t('10:20') }],
      ['planned minutes', { plannedMinutes: 30 }],
      ['pauses', { endedAt: t('10:25'), pauseIntervals: [pause('10:05', '10:06')] }],
    ])('refuses the same id with a different %s', async (_field, change) => {
      const ada = await account();
      const id = randomUUID();
      const first = asSession(await put(ada.token, id, body(ada.topicId)).expect(201));

      const res = await put(ada.token, id, body(ada.topicId, change)).expect(409);

      expect(codeOf(res)).toBe('session_id_conflict');
      expect(await sessionCount()).toBe(1);
      expect((await prisma.focusSession.findFirstOrThrow()).startedAt.toISOString()).toBe(
        first.startedAt,
      );
    });

    it('refuses the same id with a different topic', async () => {
      const ada = await account();
      const other = randomUUID();
      await http()
        .put(`/me/topics/${other}`)
        .set(auth(ada.token))
        .send({ name: 'Piano', icon: 'music', color: 'topic.2' })
        .expect(201);
      const id = randomUUID();
      await put(ada.token, id, body(ada.topicId)).expect(201);

      const res = await put(ada.token, id, body(other)).expect(409);

      expect(codeOf(res)).toBe('session_id_conflict');
    });

    it('stores one row when the same submission arrives five times at once', async () => {
      const ada = await account();
      const id = randomUUID();

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => put(ada.token, id, body(ada.topicId))),
      );

      expect(responses.map((res) => res.status).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(await sessionCount()).toBe(1);
    });

    it('lets one of two different submissions with the same id win, the other conflicts', async () => {
      const ada = await account();
      const id = randomUUID();

      const responses = await Promise.all([
        put(ada.token, id, body(ada.topicId)),
        put(ada.token, id, body(ada.topicId, { endedAt: t('10:20') })),
      ]);

      expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
      expect(codeOf(responses.find((res) => res.status === 409) as request.Response)).toBe(
        'session_id_conflict',
      );
      expect(await sessionCount()).toBe(1);
    });
  });

  describe('topic ownership', () => {
    it('does not find a topic that does not exist, and stores nothing', async () => {
      const ada = await account();
      const res = await put(ada.token, randomUUID(), body(randomUUID())).expect(404);
      expect(messageOf(res)).toContain('Topic not found');
      expect(await sessionCount()).toBe(0);
      expect(await contextCount()).toBe(0);
    });

    it('reports a missing topic before a missing time zone', async () => {
      const ada = await account('ada@example.com', null);
      await put(ada.token, randomUUID(), body(randomUUID())).expect(404);
      expect(await contextCount()).toBe(0);
    });

    it("answers another user's topic exactly like a missing one", async () => {
      const ada = await account('ada@example.com');
      const grace = await account('grace@example.com');

      const missing = await put(ada.token, randomUUID(), body(randomUUID())).expect(404);
      const others = await put(ada.token, randomUUID(), body(grace.topicId)).expect(404);

      expect(others.body).toEqual(missing.body);
      expect(await sessionCount()).toBe(0);
    });

    it("gives no sign that another user's session id exists when it is reused", async () => {
      const ada = await account('ada@example.com');
      const grace = await account('grace@example.com');
      const id = randomUUID();
      await put(ada.token, id, body(ada.topicId)).expect(201);

      await put(grace.token, id, body(grace.topicId, { endedAt: t('10:20') })).expect(201);

      expect(await sessionCount()).toBe(2);
    });
  });

  describe('overlap with stored sessions', () => {
    it.each([
      ['completed', { startedAt: t('10:00'), endedAt: t('10:25') }],
      ['ended early', { startedAt: t('10:00'), endedAt: t('10:15') }],
      ['discarded', { startedAt: t('10:00'), endedAt: t('10:03') }],
    ])('refuses a session overlapping a %s one', async (_status, first) => {
      const ada = await account();
      await submit(ada, first);

      const res = await put(
        ada.token,
        randomUUID(),
        body(ada.topicId, { startedAt: t('10:02'), endedAt: t('10:27') }),
      ).expect(409);

      expect(codeOf(res)).toBe('session_overlap');
      expect(await sessionCount()).toBe(1);
    });

    it('accepts sessions that touch without overlapping, on either side', async () => {
      const ada = await account();
      await submit(ada, { startedAt: t('10:00'), endedAt: t('10:25') });
      await submit(ada, { startedAt: t('10:25'), endedAt: t('10:50') });
      await submit(ada, { startedAt: t('09:35'), endedAt: t('10:00') });
      expect(await sessionCount()).toBe(3);
    });

    it("uses the new session's effective end too", async () => {
      const ada = await account();
      await submit(ada, { startedAt: t('10:30'), endedAt: t('10:55') });

      // Submitted end 11:40 would overlap, but this session completed at 10:25.
      await submit(ada, { startedAt: t('10:00'), endedAt: t('11:40') });

      expect(await sessionCount()).toBe(2);
    });

    it('compares against the effective end, not the submitted end', async () => {
      const ada = await account();
      // Submitted end 11:40, but the session completed at 10:25.
      await submit(ada, { startedAt: t('10:00'), endedAt: t('11:40') });

      await submit(ada, { startedAt: t('10:30'), endedAt: t('10:55') });

      expect(await sessionCount()).toBe(2);
    });

    it('refuses a session that contains a stored one', async () => {
      const ada = await account();
      await submit(ada, { startedAt: t('10:10'), endedAt: t('10:15') });
      const res = await put(ada.token, randomUUID(), body(ada.topicId)).expect(409);
      expect(codeOf(res)).toBe('session_overlap');
    });

    it('does not let a stored zero-length session block a later one', async () => {
      const ada = await account();
      await submit(ada, { startedAt: t('10:10'), endedAt: t('10:10') });
      await submit(ada, { startedAt: t('10:00'), endedAt: t('10:25') });
      expect(await sessionCount()).toBe(2);
    });

    it('lets a zero-length session sit anywhere, since it contains no instant', async () => {
      const ada = await account();
      await submit(ada, { startedAt: t('10:00'), endedAt: t('10:25') });
      const empty = await submit(ada, { startedAt: t('10:10'), endedAt: t('10:10') });
      expect(empty).toMatchObject({ status: 'discarded', focusedMilliseconds: 0 });
    });

    it('ignores other users’ sessions', async () => {
      const ada = await account('ada@example.com');
      const grace = await account('grace@example.com');
      await submit(ada);
      await submit(grace);
      expect(await sessionCount()).toBe(2);
    });
  });

  describe('concurrency', () => {
    // A test-only trigger that holds the first insert open, so the other request arrives
    // while that transaction is still running.
    async function slowInsertsFor(id: string, milliseconds: number) {
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_slow_insert() RETURNS trigger AS $$
        BEGIN
          IF NEW.id = '${id}' THEN PERFORM pg_sleep(${milliseconds / 1000}); END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER test_slow_insert BEFORE INSERT ON focus_sessions FOR EACH ROW EXECUTE FUNCTION test_slow_insert()',
      );
    }

    // Resolves once a transaction is sleeping inside the slow trigger, which means it already
    // holds everything it locked before its insert.
    async function untilAnInsertIsHeld() {
      for (let attempt = 0; attempt < 200; attempt++) {
        const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event = 'PgSleep'`;
        if ((row?.waiting ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('No insert was held open.');
    }

    afterEach(async () => {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_slow_insert ON focus_sessions');
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_failing_insert ON focus_sessions',
      );
    });

    it('persists only one of two overlapping sessions submitted at once', async () => {
      const ada = await account();
      const first = randomUUID();
      await slowInsertsFor(first, 500);

      // supertest sends only once `then` is called: start A now.
      const a = put(ada.token, first, body(ada.topicId)).then((res) => res);
      await untilAnInsertIsHeld();
      const b = put(
        ada.token,
        randomUUID(),
        body(ada.topicId, { startedAt: t('10:05'), endedAt: t('10:30') }),
      );
      const [resA, resB] = await Promise.all([a, b]);

      expect(resA.status).toBe(201);
      expect(resB.status).toBe(409);
      expect(codeOf(resB)).toBe('session_overlap');
      expect(await sessionCount()).toBe(1);
    });

    it('persists both of two adjacent sessions submitted at once', async () => {
      const ada = await account();
      const first = randomUUID();
      await slowInsertsFor(first, 300);

      // supertest sends only once `then` is called: start A now.
      const a = put(ada.token, first, body(ada.topicId)).then((res) => res);
      await untilAnInsertIsHeld();
      const b = put(
        ada.token,
        randomUUID(),
        body(ada.topicId, { startedAt: t('10:25'), endedAt: t('10:50') }),
      );
      const statuses = (await Promise.all([a, b])).map((res) => res.status);

      expect(statuses).toEqual([201, 201]);
      expect(await sessionCount()).toBe(2);
    });

    it('rolls back a month context created for a session whose insert fails', async () => {
      const ada = await account();
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_failing_insert() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'insert failed on purpose'; END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER test_failing_insert BEFORE INSERT ON focus_sessions FOR EACH ROW EXECUTE FUNCTION test_failing_insert()',
      );

      await put(ada.token, randomUUID(), body(ada.topicId)).expect(500);

      expect(await sessionCount()).toBe(0);
      expect(await contextCount()).toBe(0);
    });
  });

  describe('request validation (400)', () => {
    it.each([
      ['no topic', { topicId: undefined }],
      ['a topic id that is not a UUID', { topicId: 'reading' }],
      ['a non-string start', { startedAt: 1_790_000_000_000 }],
      ['no end', { endedAt: undefined }],
      ['non-numeric planned minutes', { plannedMinutes: '25' }],
      ['pauses that are not a list', { pauseIntervals: 'none' }],
      ['a pause without an end', { pauseIntervals: [{ startedAt: t('10:05') }] }],
      [
        'a pause with an extra field',
        { pauseIntervals: [{ ...pause('10:05', '10:06'), note: 'x' }] },
      ],
    ])('rejects %s', async (_case, overrides) => {
      const ada = await account();
      await put(ada.token, randomUUID(), body(ada.topicId, overrides)).expect(400);
      expect(await sessionCount()).toBe(0);
    });

    it.each([
      'focusedMilliseconds',
      'pausedMilliseconds',
      'status',
      'counted',
      'localDate',
      'month',
      'configVersion',
      'effectiveEnd',
      'note',
      'userId',
    ])('refuses the server-derived or unknown field %s', async (field) => {
      const ada = await account();
      const res = await put(ada.token, randomUUID(), body(ada.topicId, { [field]: 1 })).expect(400);
      expect(messageOf(res)).toContain(field);
      expect(await sessionCount()).toBe(0);
    });

    it('accepts 512 pauses and rejects 513', async () => {
      const ada = await account();
      // One-second pauses every two seconds from 10:00, inside a session ending at 10:25.
      const pauses = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
          startedAt: new Date(Date.parse(t('10:00')) + i * 2000).toISOString(),
          endedAt: new Date(Date.parse(t('10:00')) + i * 2000 + 1000).toISOString(),
        }));

      await put(ada.token, randomUUID(), body(ada.topicId, { pauseIntervals: pauses(512) })).expect(
        201,
      );
      await put(
        ada.token,
        randomUUID(),
        body(ada.topicId, {
          startedAt: t('11:00'),
          endedAt: t('11:25'),
          pauseIntervals: pauses(513),
        }),
      ).expect(400);
    });

    it('rejects a session id that is not a UUID', async () => {
      const ada = await account();
      await put(ada.token, 'not-a-uuid', body(ada.topicId)).expect(400);
    });

    it('requires a signed-in user', async () => {
      await http().put(`/me/sessions/${randomUUID()}`).send(body(randomUUID())).expect(401);
    });
  });

  it('deleting a user removes their sessions, topics, and month contexts', async () => {
    const ada = await account();
    await submit(ada);

    await prisma.user.deleteMany();

    expect(await sessionCount()).toBe(0);
    expect(await contextCount()).toBe(0);
    expect(await prisma.topic.count()).toBe(0);
  });
});
