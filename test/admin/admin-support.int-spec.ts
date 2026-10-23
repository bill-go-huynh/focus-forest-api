import { createHash, randomUUID } from 'node:crypto';

import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * CR.4 early admin support over HTTP + PostgreSQL (docs/09): look users up, read stats, the tree,
 * sessions with why each counted, reveal a note only with a reason, suspend, reactivate, and
 * delete an account, the dashboard, the configuration, and the checkpoint metrics. Reads change
 * nothing; every user-affecting action and reveal is audited.
 */

const t = new ConsistencyHarness('2026-09-03T10:00:00.000Z');
const PASSWORD = 'correct horse battery staple admin';
const hasher = new PasswordHasher({ cost: 2 ** 10 });
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

async function admin(email: string, role: 'admin' | 'support' = 'admin') {
  await createAdmin(t.prisma, hasher, { email, role, password: PASSWORD });
  const res = await t.http().post('/admin/auth/sign-in').send({ email, password: PASSWORD });
  return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
}

const audit = async () =>
  (await t.prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'asc' } }))
    .filter((row) => row.action !== 'admin.sign_in')
    .map((row) => [row.action, row.targetType, row.targetId, row.reason]);

/** Ada: a growing September tree, a counted, a discarded, and a noted session. */
async function ada(): Promise<User> {
  const user = await t.signUp('ada@example.com', 'UTC', '2026-09-01T08:00:00.000Z');
  await t.http().patch('/me/profile').set(user.auth).send({ displayName: 'Ada L' }).expect(200);
  await t.setNow('2026-09-03T11:00:00.000Z');
  await t.submit(user, '2026-09-03T10:00:00.000Z', 30, sid(1)).expect(201);
  await t.submit(user, '2026-09-03T10:40:00.000Z', 3, sid(2)).expect(201);
  await t
    .http()
    .patch(`/me/sessions/${sid(1)}/note`)
    .set(user.auth)
    .send({ note: 'Thesis chapter two, finally.' })
    .expect(200);
  return user;
}
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('admin support (CR.4, HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-09-03T10:00:00.000Z');
    await t.activateConfig();
  });

  it('finds users by email, name, or id, newest first, page by page', async () => {
    const user = await ada();
    const auth = await admin('ops@example.com', 'support');
    for (let i = 0; i < 26; i += 1) {
      await t.signUp(
        `tester${i}@example.com`,
        'UTC',
        `2026-09-02T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
      );
    }
    type Rows = { items: { id: string; email: string }[]; nextCursor: string | null };
    const get = async (query: string) =>
      (await t.http().get(`/admin/users${query}`).set(auth).expect(200)).body as Rows;
    expect((await get('?q=ADA@')).items.map((row) => row.email)).toEqual(['ada@example.com']);
    expect((await get('?q=ada l')).items.map((row) => row.id)).toEqual([user.userId]);
    expect((await get(`?q=${user.userId}`)).items).toHaveLength(1);
    const first = await get('');
    expect(first.items).toHaveLength(25);
    // Newest first: the last tester joined at 23:00 on September 2; Ada on September 1.
    expect(first.items[0]?.email).toBe('tester23@example.com');
    const second = await get(`?cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(second.items.at(-1)?.email).toBe('ada@example.com');
    expect(new Set([...first.items, ...second.items].map((row) => row.id)).size).toBe(27);
  });

  it('shows a user’s profile, lifetime, tree, rewards, and checkpoint without changing anything', async () => {
    const user = await ada();
    const auth = await admin('ops@example.com', 'support');
    const before = await t.prisma.monthlyTree.findMany({ where: { userId: user.userId } });
    const detail = (await t.http().get(`/admin/users/${user.userId}`).set(auth).expect(200))
      .body as Record<string, unknown>;
    expect(detail).toMatchObject({
      profile: {
        id: user.userId,
        email: 'ada@example.com',
        displayName: 'Ada L',
        status: 'active',
      },
      lifetime: {
        focusedMilliseconds: 30 * 60_000,
        sessionCount: 1,
        archivedTreeCount: 0,
        currentStreak: 1,
        longestStreak: 1,
      },
      currentTree: { year: 2026, month: 9, species: 'signature' },
      rewards: { badges: 1, species: 1, cosmetics: 0 },
      shareUsageData: true,
      checkpoint: { activeDays: 1, joinedOn: '2026-09-01' },
    });
    // Reading never closes a month or creates a tree.
    await t.setNow('2026-10-05T10:00:00.000Z');
    const later = await admin('later@example.com', 'support');
    await t.http().get(`/admin/users/${user.userId}`).set(later).expect(200);
    expect(await t.prisma.monthlyTree.findMany({ where: { userId: user.userId } })).toEqual(before);
    await t.http().get(`/admin/users/${randomUUID()}`).set(later).expect(404);
    await t.http().get('/admin/users/not-a-uuid').set(later).expect(400);
  });

  it('explains every session, and hides notes', async () => {
    const user = await ada();
    const auth = await admin('ops@example.com', 'support');
    type Sessions = { items: Record<string, unknown>[] };
    const res = (await t.http().get(`/admin/users/${user.userId}/sessions`).set(auth).expect(200))
      .body as Sessions;
    expect(res.items.map((row) => [row['id'], row['status'], row['hasNote']])).toEqual([
      [sid(2), 'discarded', false],
      [sid(1), 'completed', true],
    ]);
    expect(res.items[0]).toMatchObject({
      explanation: { outcome: 'below_minimum', counted: false },
      topic: { name: 'Reading' },
    });
    expect(JSON.stringify(res)).not.toContain('Thesis');
  });

  it('reveals a note only with a reason, and logs it first', async () => {
    const user = await ada();
    const auth = await admin('ops@example.com', 'support');
    const url = `/admin/users/${user.userId}/sessions/${sid(1)}/note-reveal`;
    await t.http().post(url).set(auth).send({}).expect(400);
    const revealed = await t
      .http()
      .post(url)
      .set(auth)
      .send({ reason: 'Ticket 42: note lost' })
      .expect(200);
    expect(revealed.body).toEqual({ note: 'Thesis chapter two, finally.' });
    expect(await audit()).toEqual([
      ['session.note_reveal', 'session', sid(1), 'Ticket 42: note lost'],
    ]);
    // Another user's session, or an unknown one: nothing revealed, nothing logged.
    const bob = await t.signUp('bob@example.com', 'UTC');
    await t
      .http()
      .post(`/admin/users/${bob.userId}/sessions/${sid(1)}/note-reveal`)
      .set(auth)
      .send({ reason: 'mixup' })
      .expect(404);
    expect(await audit()).toHaveLength(1);
  });

  it('suspends and reactivates an account, ending its sessions, for admins only', async () => {
    const user = await ada();
    const support = await admin('helper@example.com', 'support');
    const auth = await admin('ops@example.com');
    const url = `/admin/users/${user.userId}`;
    await t.http().post(`${url}/suspend`).set(support).send({ reason: 'abuse report' }).expect(403);
    const suspended = await t
      .http()
      .post(`${url}/suspend`)
      .set(auth)
      .send({ reason: 'abuse report' })
      .expect(200);
    expect(suspended.body).toMatchObject({ status: 'suspended' });
    await t.http().get('/me/profile').set(user.auth).expect(401);
    expect(
      await t.prisma.refreshToken.count({ where: { userId: user.userId, revokedAt: null } }),
    ).toBe(0);
    await t.http().post(`${url}/suspend`).set(auth).send({ reason: 'again' }).expect(409);
    await t.http().post(`${url}/reactivate`).set(auth).send({ reason: 'resolved' }).expect(200);
    await t.http().get('/me/profile').set(user.auth).expect(200);
    expect(await audit()).toEqual([
      ['user.suspend', 'user', user.userId, 'abuse report'],
      ['user.reactivate', 'user', user.userId, 'resolved'],
    ]);
  });

  it('deletes an account and all its data on request, with the email typed again', async () => {
    const user = await ada();
    const auth = await admin('ops@example.com');
    await t
      .http()
      .delete(`/admin/users/${user.userId}`)
      .set(auth)
      .send({ reason: 'GDPR request', confirmEmail: 'other@example.com' })
      .expect(422);
    expect(await t.prisma.user.count({ where: { id: user.userId } })).toBe(1);
    await t
      .http()
      .delete(`/admin/users/${user.userId}`)
      .set(auth)
      .send({ reason: 'GDPR request', confirmEmail: 'ADA@example.com' })
      .expect(204);
    expect(await t.prisma.user.count({ where: { id: user.userId } })).toBe(0);
    expect(await t.prisma.focusSession.count({ where: { userId: user.userId } })).toBe(0);
    expect(await t.prisma.monthlyTree.count({ where: { userId: user.userId } })).toBe(0);
    const row = await t.prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'user.delete' } });
    expect(row).toMatchObject({ targetId: user.userId, reason: 'GDPR request' });
    expect(row.details).toEqual({
      emailSha256: createHash('sha256').update('ada@example.com').digest('hex'),
    });
    expect(JSON.stringify(row)).not.toContain('ada@example.com');
  });

  it('shows the dashboard, the active configuration, and the checkpoint cohort', async () => {
    await ada();
    const auth = await admin('ops@example.com', 'support');
    const dashboard = await t.http().get('/admin/dashboard').set(auth).expect(200);
    expect(dashboard.body).toMatchObject({
      signupsLast7Days: 1,
      sessionsToday: 2,
      discardedToday: 1,
      activeUsersLast7Days: 1,
      totalUsers: 1,
      openRooms: 0,
      notificationsSentToday: 0,
    });
    // The last 14 UTC days, oldest first, today last (owner, 2026-10-23: a chart on the dashboard).
    const days = (
      dashboard.body as { days: { date: string; sessions: number; focusMinutes: number }[] }
    ).days;
    expect(days).toHaveLength(14);
    expect(days.at(-1)).toMatchObject({ sessions: 2 });
    expect(days.at(-1)!.focusMinutes).toBe(
      (dashboard.body as { focusMinutesToday: number }).focusMinutesToday,
    );
    expect(days.slice(0, -1).every((d) => d.sessions === 0)).toBe(true);
    const config = await t.http().get('/admin/config').set(auth).expect(200);
    const view = config.body as { version: number; values: Record<string, unknown> };
    expect(view.version).toBeGreaterThan(0);
    expect(typeof view.values['session.minValidMinutes']).toBe('number');
    const cohort = await t
      .http()
      .get('/admin/analytics/checkpoint?from=2026-09-01&to=2026-09-30')
      .set(auth)
      .expect(200);
    expect(cohort.body).toMatchObject({
      cohort: { users: 1 },
      users: [{ email: 'ada@example.com', activeDays: 1 }],
    });
    await t
      .http()
      .get('/admin/analytics/checkpoint?from=2026-09-30&to=2026-09-01')
      .set(auth)
      .expect(400);
    await t
      .http()
      .get('/admin/analytics/checkpoint?from=2026-13-01&to=2026-13-02')
      .set(auth)
      .expect(400);
  });
});
