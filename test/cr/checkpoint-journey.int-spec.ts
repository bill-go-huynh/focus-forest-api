import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';
import { normalize } from '../support/contract-normalize.js';
import { get, sid } from '../x3/x3-support.js';

/**
 * CR.X Core Loop Checkpoint integration (HTTP + PostgreSQL):
 *
 * 1. The analytics request exactly as the mobile app builds it (`analytics-request.json`,
 *    byte-identical with focus-forest-mobile `src/test-utils/cr/`) is accepted whole.
 * 2. A tester's September and October (app opens, focus, a gap, the archive, a return) give
 *    checkpoint metrics equal to the values derived here from the raw rows, not from the
 *    production aggregation.
 * 3. Every admin answer the web app reads is captured (`admin-contract.json`, byte-identical
 *    with focus-forest-admin `src/test/admin-contract.json`). After an intended change:
 *    `CR_UPDATE_CONTRACT=1 npm run test:int -- test/cr`, then copy the files.
 */

const REQUEST = fileURLToPath(new URL('./analytics-request.json', import.meta.url));
const CONTRACT = fileURLToPath(new URL('./admin-contract.json', import.meta.url));
const t = new ConsistencyHarness('2026-09-03T07:00:00.000Z');
const PASSWORD = 'correct horse battery staple admin';

interface Event {
  id: string;
  name: string;
  occurredAt: string;
  localDate: string;
  platform: string;
  appVersion: string;
  props: Record<string, number>;
}
let eventNumber = 100;
const event = (name: string, localDate: string, hour = 8): Event => ({
  id: sid(++eventNumber),
  name,
  occurredAt: `${localDate}T${String(hour).padStart(2, '0')}:00:00.000Z`,
  localDate,
  platform: 'android',
  appVersion: '0.1.0',
  props: {},
});

describe('Core Loop Checkpoint integration (CR.X, HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-09-03T09:00:00.000Z');
    await t.activateConfig();
    eventNumber = 100;
  });

  it('accepts the analytics request exactly as the app builds it', async () => {
    const tester = await t.signUp('tester@example.com', 'UTC', '2026-09-01T08:00:00.000Z');
    const body = JSON.parse(readFileSync(REQUEST, 'utf8')) as object;
    const res = await t.http().post('/me/analytics/events').set(tester.auth).send(body).expect(202);
    expect(res.body).toEqual({ accepted: 3, ignored: 0 });
    const rows = await t.prisma.analyticsEvent.findMany({ orderBy: { occurredAt: 'asc' } });
    expect(rows.map((row) => [row.name, row.props])).toEqual([
      ['app_opened', {}],
      ['focus_started', { plannedMinutes: 25 }],
      ['recap_opened', { year: 2026, month: 8 }],
    ]);
  });

  it('measures a tester’s months, gaps, and second-month return, and the admin shows it', async () => {
    const tester = await t.signUp('tester@example.com', 'UTC', '2026-09-01T08:00:00.000Z');
    const send = (events: Event[]) =>
      t.http().post('/me/analytics/events').set(tester.auth).send({ events }).expect(202);
    const focus = async (day: string, minutes: number, n: number) => {
      await t.setNow(`${day}T12:00:00.000Z`);
      await t.submit(tester, `${day}T09:00:00.000Z`, minutes, sid(n)).expect(201);
    };

    // September: opens on the 1st and 2nd (focus on the 2nd), a quiet week, back on the 10th.
    await t.setNow('2026-09-01T09:00:00.000Z');
    await send([event('app_opened', '2026-09-01')]);
    await focus('2026-09-02', 30, 1);
    await send([event('app_opened', '2026-09-02'), event('app_foregrounded', '2026-09-02', 10)]);
    await focus('2026-09-10', 45, 2);
    // Two quiet days only (11th, 12th): not a gap.
    await t.setNow('2026-09-13T09:00:00.000Z');
    await send([event('app_opened', '2026-09-13')]);
    // A discarded session on the 20th is not activity.
    await focus('2026-09-20', 2, 3);
    // October: September closes on the first read; back on October 3rd.
    await t.setNow('2026-10-03T09:00:00.000Z');
    await t.http().get('/me/home').set(tester.auth).expect(200);
    await send([event('app_opened', '2026-10-03')]);

    // Derived here from the raw rows.
    const opens = await t.prisma.analyticsEvent.findMany({
      where: { userId: tester.userId, name: { in: ['app_opened', 'app_foregrounded'] } },
    });
    const counted = await t.prisma.focusSession.findMany({
      where: { userId: tester.userId, NOT: { status: 'discarded' } },
    });
    const days = [
      ...new Set([
        ...opens.map((row) => row.localDate.toISOString().slice(0, 10)),
        ...counted.map((row) => row.localDate.toISOString().slice(0, 10)),
      ]),
    ].sort();
    expect(days).toEqual(['2026-09-01', '2026-09-02', '2026-09-10', '2026-09-13', '2026-10-03']);
    const gaps = days
      .slice(1)
      .filter((day, i) => (Date.parse(day) - Date.parse(days[i]!)) / 86_400_000 - 1 >= 3).length;
    const archived = await t.prisma.monthlyTree.findMany({
      where: { userId: tester.userId, status: 'archived' },
    });
    expect(archived.map((tree) => [tree.year, tree.month])).toEqual([[2026, 9]]);

    // The admin reads the same.
    await createAdmin(t.prisma, new PasswordHasher({ cost: 2 ** 10 }), {
      email: 'ops@example.com',
      role: 'support',
      password: PASSWORD,
    });
    const signIn = await t
      .http()
      .post('/admin/auth/sign-in')
      .send({ email: 'ops@example.com', password: PASSWORD })
      .expect(200);
    const admin = {
      Authorization: `Bearer ${(signIn.body as { accessToken: string }).accessToken}`,
    };
    const report = (
      await t
        .http()
        .get('/admin/analytics/checkpoint?from=2026-09-01&to=2026-09-30')
        .set(admin)
        .expect(200)
    ).body as {
      cohort: Record<string, unknown>;
      users: {
        email: string;
        activeDays: number;
        gapReturns: number;
        secondMonthReturn: boolean;
      }[];
    };
    expect(report.users).toEqual([
      expect.objectContaining({
        email: 'tester@example.com',
        activeDays: days.length,
        gapReturns: gaps,
        firstArchive: { year: 2026, month: 9 },
        secondMonthReturn: true,
        months: [
          { year: 2026, month: 9, activeDays: 4, focusDays: 2 },
          { year: 2026, month: 10, activeDays: 1, focusDays: 0 },
        ],
      }),
    ]);
    expect(report.cohort).toEqual({
      users: 1,
      multiDayFirstMonth: 1,
      returnedAfterGap: 1,
      secondMonth: { decided: 1, returned: 1 },
      medianFirstMonthActiveDays: 4,
    });
    const detail = await get(t, { ...tester, auth: admin }, `/admin/users/${tester.userId}`);
    expect(gaps).toBe(2);
    expect(detail['checkpoint']).toMatchObject({ activeDays: 5, gapReturns: gaps });
  });

  it('answers every admin route the web app reads exactly as captured', async () => {
    const tester = await t.signUp('tester@example.com', 'UTC', '2026-09-01T08:00:00.000Z');
    await t.http().patch('/me/profile').set(tester.auth).send({ displayName: 'Tess' }).expect(200);
    await t.setNow('2026-09-03T12:00:00.000Z');
    await t.submit(tester, '2026-09-03T09:00:00.000Z', 30, sid(1)).expect(201);
    await t.submit(tester, '2026-09-03T10:00:00.000Z', 2, sid(2)).expect(201);
    await t
      .http()
      .patch(`/me/sessions/${sid(1)}/note`)
      .set(tester.auth)
      .send({ note: 'A good start.' })
      .expect(200);
    await t
      .http()
      .post('/me/analytics/events')
      .set(tester.auth)
      .send({ events: [event('app_opened', '2026-09-03')] })
      .expect(202);
    const hasher = new PasswordHasher({ cost: 2 ** 10 });
    await createAdmin(t.prisma, hasher, {
      email: 'ops@example.com',
      role: 'admin',
      password: PASSWORD,
    });
    await createAdmin(t.prisma, hasher, {
      email: 'help@example.com',
      role: 'support',
      password: PASSWORD,
    });
    const signIn = async (email: string) =>
      (await t.http().post('/admin/auth/sign-in').send({ email, password: PASSWORD }).expect(200))
        .body as { accessToken: string; admin: { id: string } };
    const ops = await signIn('ops@example.com');
    await t.setNow('2026-09-03T12:00:30.000Z');
    const help = await signIn('help@example.com');
    const as = (token: string) => ({ Authorization: `Bearer ${token}` });
    const c: Record<string, unknown> = {};
    const read = async (path: string, token = ops.accessToken, status = 200) =>
      (await t.http().get(path).set(as(token)).expect(status)).body as unknown;
    // Each action a second later: the audit log's order is then its real order.
    let tick = Date.parse('2026-09-03T12:01:00.000Z');
    const post = async (path: string, body: unknown, token = ops.accessToken, status = 200) => {
      tick += 1000;
      // The clock only: re-signing app users would fail while the tester is suspended.
      t.clock.set(new Date(tick));
      const res = await t
        .http()
        .post(path)
        .set(as(token))
        .send(body as object)
        .expect(status);
      return res.body as unknown;
    };

    c['signIn'] = { ...ops, accessToken: 'admin-token' };
    c['me'] = await read('/admin/auth/me');
    c['dashboard'] = await read('/admin/dashboard');
    c['users'] = await read('/admin/users?q=tess');
    c['user'] = await read(`/admin/users/${tester.userId}`);
    c['sessions'] = await read(`/admin/users/${tester.userId}/sessions`);
    c['noteRevealed'] = await post(
      `/admin/users/${tester.userId}/sessions/${sid(1)}/note-reveal`,
      { reason: 'Support case 1' },
      help.accessToken,
    );
    c['suspendForbidden'] = await post(
      `/admin/users/${tester.userId}/suspend`,
      { reason: 'not mine' },
      help.accessToken,
      403,
    );
    c['suspended'] = await post(`/admin/users/${tester.userId}/suspend`, { reason: 'abuse' });
    c['reactivated'] = await post(`/admin/users/${tester.userId}/reactivate`, {
      reason: 'resolved',
    });
    c['deleteMismatch'] = (
      await t
        .http()
        .delete(`/admin/users/${tester.userId}`)
        .set(as(ops.accessToken))
        .send({ reason: 'request', confirmEmail: 'other@example.com' })
        .expect(422)
    ).body as unknown;
    c['userNotFound'] = await read(`/admin/users/${sid(999)}`, ops.accessToken, 404);
    c['config'] = await read('/admin/config');
    c['checkpoint'] = await read('/admin/analytics/checkpoint?from=2026-09-01&to=2026-09-30');
    const audit = (await read('/admin/audit-log')) as { items: { id: string }[] };
    c['auditLog'] = audit;

    const users = await t.prisma.adminUser.findMany({ orderBy: { email: 'asc' } });
    const replace = new Map<string, string>([
      [tester.userId, '00000000-0000-4000-8000-0000000000cc'],
      [tester.topicId, '00000000-0000-4000-8000-00000000c001'],
      ...users.map((u, i): [string, string] => [
        u.id,
        `00000000-0000-4000-8000-0000000ad${String(i).padStart(3, '0')}`,
      ]),
      ...audit.items.map((item, i): [string, string] => [
        item.id,
        `00000000-0000-4000-8000-00000000e${String(i).padStart(3, '0')}`,
      ]),
    ]);
    const captured = `${JSON.stringify(normalize(c, replace, new Map()), null, 2)}\n`;
    // No token or secret; the note appears only where it was revealed.
    expect(captured).not.toMatch(/eyJ|password/);
    expect(JSON.stringify(c['sessions'])).not.toContain('A good start.');
    expect(c['noteRevealed']).toEqual({ note: 'A good start.' });
    if (process.env['CR_UPDATE_CONTRACT'] === '1' || !existsSync(CONTRACT)) {
      writeFileSync(CONTRACT, captured);
    }
    expect(captured).toBe(readFileSync(CONTRACT, 'utf8'));
  });
});
