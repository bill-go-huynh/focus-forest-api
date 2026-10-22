import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { RateLimitService } from '../../src/safety/rate-limit.service.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';
import { normalize } from '../support/contract-normalize.js';

/**
 * X7 Release gate (HTTP + PostgreSQL): the Phase 7 safety and privacy systems working together
 * on one community, over the real API.
 *
 * 1. Ana and Ben focus, on the global board; a bot scripts overlapping sessions.
 * 2. Staff see the bot's integrity flag with its evidence and exclude it: it leaves the board.
 * 3. The app reports an error; staff read it grouped, with nothing saying who.
 * 4. Someone guesses Ana's password: the limit refuses, and staff see the refusals counted.
 * 5. Ana downloads her data, then deletes her account: she leaves every board and Ben's
 *    followers. (Events and the Community Tree were removed, owner 2026-10-22.)
 * 6. Every Phase 7 admin answer the admin app reads is captured (`release-contract.json`,
 *    byte-identical with focus-forest-admin `src/test/release-contract.json`). After an intended
 *    change: `X7_UPDATE_CONTRACT=1 npm run test:int -- test/x7`, then copy the file.
 */

const FILE = fileURLToPath(new URL('./release-contract.json', import.meta.url));
const t = new ConsistencyHarness('2026-11-06T12:00:00.000Z');
const PASSWORD = 'correct horse battery staple';
const ADMIN_PASSWORD = 'correct horse battery staple admin';
const MIN = 60_000;
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;
type Body = Record<string, unknown>;

describe('X7 release gate (HTTP + PostgreSQL)', () => {
  let limits: RateLimitService;
  beforeAll(async () => {
    await t.start();
    limits = t.app.get(RateLimitService);
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    limits.enabled = false;
    await t.setNow('2026-11-06T12:00:00.000Z');
    await t.activateConfig({ 'rateLimit.signIn': { limit: 3, windowSeconds: 900 } });
  });

  it('keeps the boards fair, the app observable, and every person in control of their data', async () => {
    const c: Record<string, unknown> = {};
    const app = async <T = Body>(user: User, path: string) =>
      (await t.http().get(path).set(user.auth).expect(200)).body as T;
    const staff = async (auth: Record<string, string>, path: string) =>
      (await t.http().get(path).set(auth).expect(200)).body as Body;

    const person = async (name: string) => {
      const user = await t.signUp(`${name}@example.com`, 'UTC', '2026-09-01T00:00:00.000Z');
      await t.http().patch('/me/profile').set(user.auth).send({ username: name }).expect(200);
      await t.http().patch('/me/privacy').set(user.auth).send({ leaderboards: true }).expect(200);
      return user;
    };
    const ana = await person('ana');
    const ben = await person('ben');
    const bot = await person('bot');
    await t.http().put(`/me/following/${ben.userId}`).set(ana.auth).expect(200);
    await t.http().put(`/me/following/${ana.userId}`).set(ben.auth).expect(200);

    // 1. Ordinary focus through the API; the bot stores two sessions that overlap.
    await t.setNow('2026-11-06T09:31:00.000Z');
    await t.submit(ana, '2026-11-06T09:00:00.000Z', 30).expect(201);
    await t.submit(ben, '2026-11-06T09:00:00.000Z', 25).expect(201);
    await t.prisma.monthAttributionContext.create({
      data: {
        userId: bot.userId,
        year: 2026,
        month: 11,
        timezone: 'UTC',
        startsAt: new Date('2026-11-01T00:00:00.000Z'),
        endsAt: new Date('2026-12-01T00:00:00.000Z'),
      },
    });
    for (const start of ['2026-11-05T08:00:00.000Z', '2026-11-05T08:20:00.000Z']) {
      const startedAt = new Date(start);
      const endedAt = new Date(startedAt.getTime() + 60 * MIN);
      await t.prisma.focusSession.create({
        data: {
          id: randomUUID(),
          userId: bot.userId,
          topicId: bot.topicId,
          startedAt,
          submittedEndedAt: endedAt,
          effectiveEndedAt: endedAt,
          plannedMinutes: 60,
          pauseIntervals: [],
          focusedMilliseconds: 60 * MIN,
          pausedMilliseconds: 0,
          status: 'completed',
          localDate: new Date('2026-11-05T00:00:00.000Z'),
          year: 2026,
          month: 11,
          configVersion: 4,
          createdAt: new Date(endedAt.getTime() + MIN),
        },
      });
    }
    const board = async (viewer: User = ben) =>
      (
        await app<{ rows: { person: { username: string } }[] }>(
          viewer,
          '/leaderboards?scope=global&period=weekly',
        )
      ).rows.map((row) => row.person.username);
    expect((await board()).sort()).toEqual(['ana', 'ben', 'bot']);

    // 2. Staff see the flag with its evidence, and exclude the bot.
    await createAdmin(t.prisma, new PasswordHasher({ cost: 2 ** 10 }), {
      email: 'ops@example.com',
      role: 'admin',
      password: ADMIN_PASSWORD,
    });
    const signInStaff = async () => {
      const res = await t
        .http()
        .post('/admin/auth/sign-in')
        .send({ email: 'ops@example.com', password: ADMIN_PASSWORD })
        .expect(200);
      return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
    };
    const ops = await signInStaff();
    c['integrityFlags'] = await staff(ops, '/admin/integrity/flags');
    const flagged = (
      c['integrityFlags'] as { items: { user: { username: string }; flags: Body[] }[] }
    ).items;
    expect(flagged.map((item) => [item.user.username, item.flags.map((f) => f['kind'])])).toEqual([
      ['bot', ['overlap']],
    ]);
    await t
      .http()
      .post('/admin/live/leaderboard-exclusions')
      .set(ops)
      .send({ userId: bot.userId, reason: 'Two sessions at once, scripted' })
      .expect(201);
    expect((await board()).sort()).toEqual(['ana', 'ben']);
    expect((await staff(ops, '/admin/integrity/flags'))['items']).toEqual([]);

    // 3. The app reports an error, with nothing saying who.
    await t
      .http()
      .post('/client-errors')
      .send({
        errors: [
          {
            occurredAt: '2026-11-06T09:40:00.000Z',
            kind: 'crash',
            platform: 'android',
            appVersion: '1.0.0',
            screen: '/together/leaderboards',
            message: 'TypeError: rows is undefined (ana@example.com)',
          },
        ],
      })
      .expect(202);
    c['clientErrors'] = await staff(ops, '/admin/client-errors?days=1');
    expect(JSON.stringify(c['clientErrors'])).not.toContain('ana@example.com');

    // 4. Someone guesses Ana's password: three tries, then refusals.
    limits.enabled = true;
    for (let i = 0; i < 3; i += 1) {
      await t
        .http()
        .post('/auth/sign-in')
        .send({ email: 'ana@example.com', password: 'guess' })
        .expect(401);
    }
    c['rateLimited'] = (
      await t
        .http()
        .post('/auth/sign-in')
        .send({ email: 'ana@example.com', password: 'guess' })
        .expect(429)
    ).body;
    limits.enabled = false;
    c['rateLimits'] = await staff(ops, '/admin/rate-limits');
    expect((c['rateLimits'] as { items: Body[] }).items[0]).toMatchObject({
      name: 'signIn',
      refused: 1,
    });

    // 5. Ana takes her data, then leaves.
    const exported = await app<{ sessions: unknown[]; social: { followers: unknown[] } }>(
      ana,
      '/me/export',
    );
    expect(exported.sessions).toHaveLength(1);
    expect(exported.social.followers).toEqual([
      { userId: ben.userId, createdAt: expect.any(String) as string },
    ]);
    await t.http().delete('/me').set(ana.auth).send({ password: PASSWORD }).expect(204);

    // She leaves every board and Ben's followers.
    await t.http().get('/me/profile').set(ana.auth).expect(401);
    expect(await board()).toEqual(['ben']);
    expect((await app<{ items: unknown[] }>(ben, '/me/followers')).items).toEqual([]);
    // 6. The capture.
    const replace = new Map<string, string>([
      [ana.userId, '00000000-0000-4000-8000-0000000007a1'],
      [ben.userId, '00000000-0000-4000-8000-0000000007a2'],
      [bot.userId, '00000000-0000-4000-8000-0000000007a3'],
    ]);
    const botSessions = await t.prisma.focusSession.findMany({
      where: { userId: bot.userId },
      orderBy: { startedAt: 'asc' },
    });
    botSessions.forEach((session, i) =>
      replace.set(session.id, `00000000-0000-4000-8000-0000000007b${i + 1}`),
    );
    const flagKey = `overlap:${botSessions[0]!.id}:${botSessions[1]!.id}`;
    replace.set(
      flagKey,
      'overlap:00000000-0000-4000-8000-0000000007b1:00000000-0000-4000-8000-0000000007b2',
    );
    const captured = `${JSON.stringify(normalize(c, replace, new Map()), null, 2)}\n`;
    expect(captured).not.toMatch(/eyJ|password/);
    if (process.env['X7_UPDATE_CONTRACT'] === '1' || !existsSync(FILE)) {
      writeFileSync(FILE, captured);
    }
    expect(captured).toBe(readFileSync(FILE, 'utf8'));
  }, 120_000);
});
