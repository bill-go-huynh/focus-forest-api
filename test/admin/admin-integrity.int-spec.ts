import { randomUUID } from 'node:crypto';

import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A7.3 Leaderboard integrity (docs/12 Phase 20: leaderboard manipulation; Phase 7 owner decision
 * 8: flag only, staff decide). Staff see implausible focus with its evidence, then exclude the
 * account from boards (A6.5) or dismiss the flag with a reason; nothing changes on its own.
 */

const t = new ConsistencyHarness('2026-11-06T12:00:00.000Z');
const PASSWORD = 'correct horse battery staple admin';
const hasher = new PasswordHasher({ cost: 2 ** 10 });
const MIN = 60_000;
type Auth = Record<string, string>;
type Body = Record<string, unknown>;
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

async function admin(email: string, role: 'admin' | 'support' | 'moderator' | 'content') {
  await createAdmin(t.prisma, hasher, { email, role, password: PASSWORD });
  const res = await t.http().post('/admin/auth/sign-in').send({ email, password: PASSWORD });
  return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` } as Auth;
}

/** A stored, counted session, `submittedAfter` minutes after its end. */
async function stored(user: User, start: string, minutes: number, submittedAfter = 1) {
  const startedAt = new Date(start);
  const endedAt = new Date(startedAt.getTime() + minutes * MIN);
  const [year = 0, month = 1] = start.split('-').map(Number);
  await t.prisma.monthAttributionContext.upsert({
    where: { userId_year_month: { userId: user.userId, year, month } },
    update: {},
    create: {
      userId: user.userId,
      year,
      month,
      timezone: 'UTC',
      startsAt: new Date(Date.UTC(year, month - 1, 1)),
      endsAt: new Date(Date.UTC(year, month, 1)),
    },
  });
  await t.prisma.focusSession.create({
    data: {
      id: randomUUID(),
      userId: user.userId,
      topicId: user.topicId,
      startedAt,
      submittedEndedAt: endedAt,
      effectiveEndedAt: endedAt,
      plannedMinutes: minutes,
      pauseIntervals: [],
      focusedMilliseconds: minutes * MIN,
      pausedMilliseconds: 0,
      status: 'completed',
      localDate: new Date(`${start.slice(0, 10)}T00:00:00.000Z`),
      year,
      month,
      configVersion: 4,
      createdAt: new Date(endedAt.getTime() + submittedAfter * MIN),
    },
  });
}

describe('leaderboard integrity (A7.3)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-11-06T12:00:00.000Z');
    await t.activateConfig();
  });

  /** On the boards: an opted-in person with a username. */
  async function player(name: string) {
    const user = await t.signUp(`${name}@example.com`);
    await t.http().patch('/me/profile').set(user.auth).send({ username: name }).expect(200);
    await t.http().patch('/me/privacy').set(user.auth).send({ leaderboards: true }).expect(200);
    return user;
  }

  it('lists implausible focus with its evidence, for people on the boards', async () => {
    const ana = await player('ana');
    const ben = await player('ben');
    // Cai has a username but never opted into boards.
    const cai = await t.signUp('cai@example.com');
    await t.http().patch('/me/profile').set(cai.auth).send({ username: 'cai' }).expect(200);
    // Ana: two sessions at once, and 17 hours in a day.
    await stored(ana, '2026-11-03T08:00:00.000Z', 60);
    await stored(ana, '2026-11-03T08:30:00.000Z', 60);
    await stored(ana, '2026-11-04T00:00:00.000Z', 1020);
    // Ben: an ordinary week, except one session sent five days after it ended.
    await stored(ben, '2026-11-02T08:00:00.000Z', 50);
    await stored(ben, '2026-11-01T08:00:00.000Z', 40, 5 * 24 * 60);
    // Cai would be flagged, but is on no board.
    await stored(cai, '2026-11-04T00:00:00.000Z', 1020);

    const auth = await admin('content@example.com', 'content');
    const res = await t.http().get('/admin/integrity/flags').set(auth).expect(200);
    const items = (res.body as { items: Body[] }).items;
    expect(items.map((item) => (item['user'] as Body)['username'])).toEqual(['ana', 'ben']);
    expect((items[0]!['flags'] as Body[]).map((flag) => flag['kind'])).toEqual([
      'overlap',
      'day_total',
    ]);
    expect(items[0]!['flags']).toContainEqual({
      kind: 'day_total',
      key: 'day:2026-11-04',
      detail: { localDate: '2026-11-04', focusMinutes: 1020 },
    });
    expect(items[1]!['flags']).toEqual([
      expect.objectContaining({
        kind: 'late',
        detail: expect.objectContaining({ hoursLate: 120 }) as unknown,
      }),
    ]);
    // Flags change nothing on their own: Ana is still on the board.
    expect(await t.prisma.leaderboardExclusion.count()).toBe(0);
  });

  it('dismisses a flag for good with a reason, and leaves excluded accounts out', async () => {
    const ana = await player('ana');
    const ben = await player('ben');
    await stored(ana, '2026-11-04T00:00:00.000Z', 1020);
    await stored(ben, '2026-11-04T00:00:00.000Z', 1000);
    const auth = await admin('admin@example.com', 'admin');

    await t
      .http()
      .post('/admin/integrity/dismissals')
      .set(auth)
      .send({ userId: ana.userId, key: 'day:2026-11-04', reason: 'A real marathon day; checked' })
      .expect(201);
    // Dismissing twice, or without a reason, is refused.
    await t
      .http()
      .post('/admin/integrity/dismissals')
      .set(auth)
      .send({ userId: ana.userId, key: 'day:2026-11-04', reason: 'Again' })
      .expect(409);
    await t
      .http()
      .post('/admin/integrity/dismissals')
      .set(auth)
      .send({ userId: ben.userId, key: 'day:2026-11-04', reason: '' })
      .expect(400);

    await t
      .http()
      .post('/admin/live/leaderboard-exclusions')
      .set(auth)
      .send({ userId: ben.userId, reason: 'Scripted sessions' })
      .expect(201);
    const res = await t.http().get('/admin/integrity/flags').set(auth).expect(200);
    expect((res.body as { items: unknown[] }).items).toEqual([]);

    // New evidence about Ana still shows.
    await stored(ana, '2026-11-05T00:00:00.000Z', 1000);
    const again = await t.http().get('/admin/integrity/flags').set(auth).expect(200);
    expect(
      ((again.body as { items: Body[] }).items[0]!['flags'] as Body[]).map((f) => f['key']),
    ).toEqual(['day:2026-11-05']);

    const audit = await t.prisma.adminAuditLog.findMany({ where: { action: 'integrity.dismiss' } });
    expect(audit.map((row) => [row.targetId, row.reason, row.details])).toEqual([
      [ana.userId, 'A real marathon day; checked', { key: 'day:2026-11-04' }],
    ]);
  });

  it('looks back four weeks only', async () => {
    const ana = await player('ana');
    await stored(ana, '2026-10-01T00:00:00.000Z', 1020);
    // An ordinary session this week keeps her in view; the old day still does not show.
    await stored(ana, '2026-11-05T08:00:00.000Z', 30);
    const auth = await admin('admin@example.com', 'admin');
    const res = await t.http().get('/admin/integrity/flags').set(auth).expect(200);
    expect((res.body as { items: unknown[] }).items).toEqual([]);
  });

  it('is for admins and content staff only', async () => {
    for (const role of ['support', 'moderator'] as const) {
      const auth = await admin(`${role}@example.com`, role);
      await t.http().get('/admin/integrity/flags').set(auth).expect(403);
    }
  });
});
