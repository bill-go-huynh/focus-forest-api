import { randomUUID } from 'node:crypto';

import { JobsService } from '../../src/jobs/jobs.service.js';
import { RateLimitService } from '../../src/safety/rate-limit.service.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A7.2 Rate limits (docs/12 Phase 20: abuse and safety checks; Phase 7 owner decision 2: our own
 * Postgres counters, no dependency). Fixed windows per address, email, or person, with limits
 * from the active configuration; a refusal says when to try again.
 */

const t = new ConsistencyHarness('2026-11-02T10:00:00.000Z');
const PASSWORD = 'correct horse battery staple';
const limit = (limit: number, windowSeconds: number) => ({ limit, windowSeconds });
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

describe('rate limits (A7.2)', () => {
  beforeAll(async () => {
    await t.start();
    // The integration tests run with RATE_LIMITS=off; this file checks the limits themselves.
    t.app.get(RateLimitService).enabled = true;
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-11-02T10:00:00.000Z');
    await t.activateConfig();
  });

  const tight = (overrides: Record<string, unknown>) => t.activateConfig(overrides);
  const signIn = (email: string, password = 'wrong password, again') =>
    t.http().post('/auth/sign-in').send({ email, password });

  it('slows guessing a password, per email and per address, then lets it through again', async () => {
    await t.signUp('ana@example.com');
    await tight({ 'rateLimit.signIn': limit(3, 900) });
    for (let i = 0; i < 3; i += 1) await signIn('ana@example.com').expect(401);
    const refused = await signIn('ana@example.com', PASSWORD).expect(429);
    expect(refused.body).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Too many attempts. Please wait a little and try again.',
      code: 'rate_limited',
      retryAfterSeconds: 900,
    });
    expect(refused.headers['retry-after']).toBe('900');
    // The same address trying another email is held too.
    await signIn('ben@example.com').expect(429);

    // The window ends: the right password works.
    t.clock.set(new Date('2026-11-02T10:15:00.000Z'));
    await signIn('ana@example.com', PASSWORD).expect(200);
  });

  it('counts windows from their start, so Retry-After shrinks', async () => {
    await tight({ 'rateLimit.signIn': limit(1, 600) });
    await signIn('ana@example.com').expect(401);
    t.clock.set(new Date('2026-11-02T10:04:00.000Z'));
    const res = await signIn('ana@example.com').expect(429);
    expect(res.headers['retry-after']).toBe('360');
  });

  it('limits new accounts per address', async () => {
    await tight({ 'rateLimit.signUp': limit(2, 3600) });
    for (const name of ['a', 'b']) {
      await t
        .http()
        .post('/auth/sign-up')
        .send({ email: `${name}@example.com`, password: PASSWORD })
        .expect(201);
    }
    await t
      .http()
      .post('/auth/sign-up')
      .send({ email: 'c@example.com', password: PASSWORD })
      .expect(429);
    expect(await t.prisma.user.count()).toBe(2);
  });

  describe('per person', () => {
    let ana: User;
    let ben: User;
    let cai: User;
    beforeEach(async () => {
      ana = await t.signUp('ana@example.com');
      ben = await t.signUp('ben@example.com');
      cai = await t.signUp('cai@example.com');
    });

    it('limits reports, follows, and reactions for one person, never for others', async () => {
      await tight({
        'rateLimit.reports': limit(1, 86_400),
        'rateLimit.follows': limit(1, 3600),
        'rateLimit.reactions': limit(1, 3600),
      });
      const report = (user: User, targetId: string) =>
        t
          .http()
          .post('/me/reports')
          .set(user.auth)
          .send({ userId: targetId, category: 'behavior' });
      expect((await report(ana, ben.userId)).status).toBeLessThan(300);
      await report(ana, cai.userId).expect(429);
      expect((await report(ben, cai.userId)).status).toBeLessThan(300);

      await t.http().put(`/me/following/${ben.userId}`).set(ana.auth).expect(200);
      await t.http().put(`/me/following/${cai.userId}`).set(ana.auth).expect(429);
      await t.http().put(`/me/following/${ana.userId}`).set(ben.auth).expect(200);

      // Reactions need a visible forest: friends see each other's by default.
      await t.http().put(`/me/following/${ana.userId}`).set(cai.auth).expect(200);
      const react = (kind: string) =>
        t.http().put(`/users/${ben.userId}/reactions/${kind}?target=forest`).set(ana.auth);
      expect((await react('fire')).status).toBeLessThan(300);
      await react('heart').expect(429);
    });

    it('limits invitations, rooms and challenges together', async () => {
      await tight({ 'rateLimit.invites': limit(1, 3600) });
      for (const [a, b] of [
        [ana, ben],
        [ana, cai],
      ] as const) {
        await t.http().put(`/me/following/${b.userId}`).set(a.auth).expect(200);
        await t.http().put(`/me/following/${a.userId}`).set(b.auth).expect(200);
      }
      await t
        .http()
        .post('/me/challenges')
        .set(ana.auth)
        .send({ templateId: 'steady-week-together', invite: [ben.userId] })
        .expect(201);
      const room = await t
        .http()
        .post('/rooms')
        .set(ana.auth)
        .send({ name: 'Study', durationMinutes: 25, maxParticipants: 4, visibility: 'private' })
        .expect(201);
      await t
        .http()
        .post(`/rooms/${(room.body as { id: string }).id}/invites`)
        .set(ana.auth)
        .send({ userIds: [cai.userId] })
        .expect(429);
    });

    it('slows guessing private room codes and scraping people search', async () => {
      await tight({ 'rateLimit.roomCodes': limit(2, 3600), 'rateLimit.search': limit(1, 3600) });
      for (const code of ['AAAAAA', 'BBBBBB']) {
        await t.http().post('/rooms/join').set(ana.auth).send({ code }).expect(404);
      }
      await t.http().post('/rooms/join').set(ana.auth).send({ code: 'CCCCCC' }).expect(429);
      await t.http().get('/users/search?q=be').set(ana.auth).expect(200);
      await t.http().get('/users/search?q=ca').set(ana.auth).expect(429);
    });

    it('limits password checks before deletion', async () => {
      await tight({ 'rateLimit.deleteAttempts': limit(2, 3600) });
      for (let i = 0; i < 2; i += 1) {
        await t.http().delete('/me').set(ana.auth).send({ password: 'not it' }).expect(403);
      }
      await t.http().delete('/me').set(ana.auth).send({ password: PASSWORD }).expect(429);
      expect(await t.prisma.user.count({ where: { id: ana.userId } })).toBe(1);
    });

    it('limits analytics batches', async () => {
      await tight({ 'rateLimit.analytics': limit(1, 3600) });
      const batch = () => ({
        events: [
          {
            id: randomUUID(),
            name: 'app_opened',
            occurredAt: '2026-11-02T10:00:00.000Z',
            localDate: '2026-11-02',
            platform: 'ios',
            appVersion: '1.0.0',
            props: {},
          },
        ],
      });
      expect(
        (await t.http().post('/me/analytics/events').set(ana.auth).send(batch())).status,
      ).toBeLessThan(300);
      await t.http().post('/me/analytics/events').set(ana.auth).send(batch()).expect(429);
    });
  });

  it('forgets windows a day old', async () => {
    await tight({ 'rateLimit.signIn': limit(5, 900) });
    await signIn('ana@example.com').expect(401);
    expect(await t.prisma.rateLimitWindow.count()).toBe(2);
    const jobs = t.app.get(JobsService);
    await jobs.startRecurring(new Date('2026-11-03T11:00:00.000Z'));
    await jobs.runDue(new Date('2026-11-03T11:00:00.000Z'));
    expect(await t.prisma.rateLimitWindow.count()).toBe(0);
  });

  it('keeps no email or address in the counters', async () => {
    await signIn('ana@example.com').expect(401);
    const buckets = (await t.prisma.rateLimitWindow.findMany()).map((row) => row.bucket);
    expect(buckets).toHaveLength(2);
    expect(buckets.join(' ')).not.toMatch(/ana@example|127\.0\.0\.1|::1/);
  });
});
