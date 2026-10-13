import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { RateLimitService } from '../../src/safety/rate-limit.service.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A7.4 Error monitoring, self-built (Phase 7 owner decision 1: no Sentry, no third party). The
 * apps report what went wrong, signed in or not; nothing says who; staff read it grouped. Every
 * response carries a request id, and readiness checks the database.
 */

const t = new ConsistencyHarness('2026-11-02T10:00:00.000Z');
const PASSWORD = 'correct horse battery staple admin';
const hasher = new PasswordHasher({ cost: 2 ** 10 });
type Body = Record<string, unknown>;

const report = (overrides: Body = {}) => ({
  occurredAt: '2026-11-02T09:59:00.000Z',
  kind: 'crash',
  platform: 'ios',
  appVersion: '1.2.0',
  screen: 'home',
  message: 'TypeError: undefined is not an object (evaluating tree.stage)',
  stack: 'at TreeScene (Tree.tsx:12)\nat Home (index.tsx:40)',
  ...overrides,
});
const send = (errors: Body[]) => t.http().post('/client-errors').send({ errors });

async function admin(email: string, role: 'admin' | 'support' | 'moderator' | 'content') {
  await createAdmin(t.prisma, hasher, { email, role, password: PASSWORD });
  const res = await t.http().post('/admin/auth/sign-in').send({ email, password: PASSWORD });
  return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
}

describe('client errors and health (A7.4)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-11-02T10:00:00.000Z');
    await t.activateConfig();
  });

  it('accepts reports without a session, keeping no one’s identity', async () => {
    const res = await send([report(), report({ kind: 'error', screen: null, stack: null })]).expect(
      202,
    );
    expect(res.body).toEqual({ accepted: 2 });
    const rows = await t.prisma.clientError.findMany({ orderBy: { kind: 'asc' } });
    expect(rows.map((row) => [row.kind, row.screen, row.receivedAt.toISOString()])).toEqual([
      ['crash', 'home', '2026-11-02T10:00:00.000Z'],
      ['error', null, '2026-11-02T10:00:00.000Z'],
    ]);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'appVersion',
      'id',
      'kind',
      'message',
      'occurredAt',
      'platform',
      'receivedAt',
      'screen',
      'stack',
    ]);
  });

  it('cuts long text and removes email addresses', async () => {
    await send([
      report({
        message: `Could not sign in ana.lopez@example.com ${'x'.repeat(600)}`,
        stack: 'y'.repeat(5000),
      }),
    ]).expect(202);
    const row = await t.prisma.clientError.findFirstOrThrow();
    expect(row.message.startsWith('Could not sign in [email] xxx')).toBe(true);
    expect(row.message).toHaveLength(500);
    expect(row.stack).toHaveLength(4000);
  });

  it('refuses what is not a report, and more than twenty at once', async () => {
    await send([report({ kind: 'oops' })]).expect(400);
    await send([report({ platform: 'web' })]).expect(400);
    await send([report({ message: '' })]).expect(400);
    await send(Array.from({ length: 21 }, () => report())).expect(400);
    await send([]).expect(400);
    expect(await t.prisma.clientError.count()).toBe(0);
  });

  it('limits reports per address', async () => {
    await t.activateConfig({ 'rateLimit.clientErrors': { limit: 2, windowSeconds: 3600 } });
    const limits = t.app.get(RateLimitService);
    limits.enabled = true;
    try {
      await send([report()]).expect(202);
      await send([report()]).expect(202);
      await send([report()]).expect(429);
    } finally {
      limits.enabled = false;
    }
  });

  it('shows staff the reports grouped, newest group first', async () => {
    await send([report(), report()]).expect(202);
    await t.setNow('2026-11-02T11:00:00.000Z');
    await send([report({ appVersion: '1.3.0', message: 'Network request failed' })]).expect(202);
    const auth = await admin('support@example.com', 'support');
    const res = await t.http().get('/admin/client-errors?days=7').set(auth).expect(200);
    expect((res.body as { items: Body[] }).items).toEqual([
      {
        kind: 'crash',
        message: 'Network request failed',
        platform: 'ios',
        appVersion: '1.3.0',
        screen: 'home',
        count: 1,
        firstSeen: '2026-11-02T11:00:00.000Z',
        lastSeen: '2026-11-02T11:00:00.000Z',
        stack: 'at TreeScene (Tree.tsx:12)\nat Home (index.tsx:40)',
      },
      {
        kind: 'crash',
        message: 'TypeError: undefined is not an object (evaluating tree.stage)',
        platform: 'ios',
        appVersion: '1.2.0',
        screen: 'home',
        count: 2,
        firstSeen: '2026-11-02T10:00:00.000Z',
        lastSeen: '2026-11-02T10:00:00.000Z',
        stack: 'at TreeScene (Tree.tsx:12)\nat Home (index.tsx:40)',
      },
    ]);
    const moderator = await admin('moderator@example.com', 'moderator');
    await t.http().get('/admin/client-errors').set(moderator).expect(403);
  });

  it('forgets reports after thirty days', async () => {
    await send([report()]).expect(202);
    const jobs = t.app.get(JobsService);
    // A month later every recurring chain has slots to catch up on: run until none is due.
    const runAll = async (iso: string) => {
      await jobs.startRecurring(new Date(iso));
      while ((await jobs.runDue(new Date(iso))).ran > 0);
    };
    await runAll('2026-12-02T10:00:00.000Z');
    expect(await t.prisma.clientError.count()).toBe(1);
    await runAll('2026-12-03T10:00:00.000Z');
    expect(await t.prisma.clientError.count()).toBe(0);
  });

  it('gives every response a request id, keeping a well-formed one the client sent', async () => {
    const plain = await t.http().get('/health').expect(200);
    expect(plain.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const kept = await t.http().get('/health').set('X-Request-Id', 'app-1234abcd').expect(200);
    expect(kept.headers['x-request-id']).toBe('app-1234abcd');
    const replaced = await t
      .http()
      .get('/health')
      .set('X-Request-Id', 'not ok! forged')
      .expect(200);
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is ready when the database answers', async () => {
    expect((await t.http().get('/health/ready').expect(200)).body).toEqual({
      status: 'ok',
      database: 'ok',
    });
  });
});
