import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A5.3 reports and moderation (spec §19.3, docs/09 Reports and moderation): users report an
 * account, username, avatar, bio, or behavior; moderators work the queue with audited actions.
 */

const t = new ConsistencyHarness('2026-10-09T10:00:00.000Z');
const PASSWORD = 'correct horse battery staple admin';
const hasher = new PasswordHasher({ cost: 2 ** 10 });
type Auth = Record<string, string>;
interface User {
  userId: string;
  auth: Auth;
}
type Body = Record<string, unknown>;

async function admin(email: string, role: 'admin' | 'support' | 'moderator'): Promise<Auth> {
  await createAdmin(t.prisma, hasher, { email, role, password: PASSWORD });
  const res = await t.http().post('/admin/auth/sign-in').send({ email, password: PASSWORD });
  return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
}

async function person(name: string): Promise<User> {
  const user = await t.signUp(`${name}@example.com`);
  await t
    .http()
    .patch('/me/profile')
    .set(user.auth)
    .send({ username: name, displayName: name, bio: `${name} bio` })
    .expect(200);
  return user;
}

const report = (from: User, about: User, category: string, details?: string) =>
  t
    .http()
    .post('/me/reports')
    .set(from.auth)
    .send({ userId: about.userId, category, ...(details !== undefined && { details }) });

const audit = async () =>
  (await t.prisma.adminAuditLog.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
    .filter((row) => row.action !== 'admin.sign_in')
    .map((row) => [row.action, row.targetType, row.targetId, row.reason]);

describe('reports and moderation (A5.3, HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-09T10:00:00.000Z');
  });

  describe('filing a report', () => {
    it('stores one unfinished report per reporter, user, and category', async () => {
      const ada = await person('ada');
      const bob = await person('bob');

      const first = await report(ada, bob, 'bio', '  Insults in the bio.  ').expect(201);
      expect(first.body).toEqual({
        id: expect.any(String) as string,
        category: 'bio',
        status: 'open',
        createdAt: '2026-10-09T10:00:00.000Z',
      });
      const again = await report(ada, bob, 'bio', 'Another try').expect(200);
      expect((again.body as Body)['id']).toBe((first.body as Body)['id']);
      await report(ada, bob, 'username').expect(201);
      const stored = await t.prisma.report.findMany({ orderBy: { createdAt: 'asc' } });
      expect(stored).toHaveLength(2);
      expect(stored[0]).toMatchObject({ details: 'Insults in the bio.', category: 'bio' });
    });

    it('can report anyone who exists, a blocked or suspended user included', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      await t.http().put(`/me/blocks/${ada.userId}`).set(bob.auth).expect(204);
      await report(ada, bob, 'behavior').expect(201);
      await t.prisma.user.update({ where: { id: cyd.userId }, data: { status: 'suspended' } });
      await report(ada, cyd, 'account').expect(201);
    });

    it('refuses yourself, unknown users, unknown categories, and long details', async () => {
      const ada = await person('ada');
      const self = await report(ada, ada, 'bio').expect(422);
      expect(self.body).toMatchObject({ code: 'cannot_report_self' });
      await t
        .http()
        .post('/me/reports')
        .set(ada.auth)
        .send({ userId: '0199c000-0000-7000-8000-000000000000', category: 'bio' })
        .expect(404);
      const bob = await person('bob');
      await report(ada, bob, 'notes').expect(400);
      await report(ada, bob, 'bio', 'x'.repeat(501)).expect(400);
      await t.http().post('/me/reports').send({ userId: bob.userId, category: 'bio' }).expect(401);
    });
  });

  describe('roles', () => {
    it('lets admins and moderators work reports, never support', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      await report(ada, bob, 'bio').expect(201);
      const support = await admin('support@example.com', 'support');
      const moderator = await admin('mod@example.com', 'moderator');
      const boss = await admin('boss@example.com', 'admin');
      const denied = await t.http().get('/admin/reports').set(support).expect(403);
      expect(denied.body).toMatchObject({ code: 'admin_role_forbidden' });
      await t.http().get('/admin/reports').set(moderator).expect(200);
      await t.http().get('/admin/reports').set(boss).expect(200);
    });

    it('keeps notes, account deletion, and reactivation away from moderators', async () => {
      const ada = await person('ada');
      const moderator = await admin('mod@example.com', 'moderator');
      await t
        .http()
        .post(
          `/admin/users/${ada.userId}/sessions/00000000-0000-4000-8000-000000000001/note-reveal`,
        )
        .set(moderator)
        .send({ reason: 'curious' })
        .expect(403);
      await t
        .http()
        .post(`/admin/users/${ada.userId}/reactivate`)
        .set(moderator)
        .send({ reason: 'nope' })
        .expect(403);
      await t.http().get(`/admin/users/${ada.userId}`).set(moderator).expect(200);
    });
  });

  describe('the queue', () => {
    it('lists open and in-review reports oldest first, with context', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      const moderator = await admin('mod@example.com', 'moderator');
      await report(ada, bob, 'bio', 'Rude').expect(201);
      t.clock.advance(1_000);
      await report(cyd, bob, 'behavior').expect(201);
      t.clock.advance(1_000);
      await report(bob, ada, 'username').expect(201);

      const res = await t.http().get('/admin/reports').set(moderator).expect(200);
      const body = res.body as { items: Body[]; nextCursor: string | null };
      expect(
        body.items.map((item) => [item['category'], (item['target'] as Body)['username']]),
      ).toEqual([
        ['bio', 'bob'],
        ['behavior', 'bob'],
        ['username', 'ada'],
      ]);
      expect(body.items[0]).toEqual({
        id: expect.any(String) as string,
        category: 'bio',
        status: 'open',
        details: 'Rude',
        createdAt: '2026-10-09T10:00:00.000Z',
        reporter: { id: ada.userId, email: 'ada@example.com', username: 'ada', displayName: 'ada' },
        target: {
          id: bob.userId,
          email: 'bob@example.com',
          username: 'bob',
          displayName: 'bob',
          status: 'active',
          openReports: 2,
        },
      });
      expect(body.nextCursor).toBeNull();

      // In review stays in the default queue; resolved and dismissed leave it.
      const [first, second, third] = body.items.map(
        (item) => `/admin/reports/${item['id'] as string}`,
      );
      await t.http().post(`${first}/review`).set(moderator).expect(200);
      await t
        .http()
        .post(`${second}/dismiss`)
        .set(moderator)
        .send({ reason: 'Not abusive' })
        .expect(200);
      await t
        .http()
        .post(`${third}/resolve`)
        .set(moderator)
        .send({ action: 'none', reason: 'Nothing to do' })
        .expect(200);
      const after = (await t.http().get('/admin/reports').set(moderator).expect(200)).body as {
        items: Body[];
      };
      expect(after.items.map((item) => item['status'])).toEqual(['in_review']);
      const dismissed = (
        await t
          .http()
          .get('/admin/reports')
          .query({ status: 'dismissed' })
          .set(moderator)
          .expect(200)
      ).body as { items: Body[] };
      expect(dismissed.items.map((item) => item['category'])).toEqual(['behavior']);

      const resolved = await t
        .http()
        .get('/admin/reports')
        .query({ status: 'resolved' })
        .set(moderator)
        .expect(200);
      expect((resolved.body as { items: Body[] }).items.map((item) => item['category'])).toEqual([
        'username',
      ]);
      await t.http().get('/admin/reports').query({ status: 'gone' }).set(moderator).expect(400);
    });

    it('pages the queue', async () => {
      const ada = await person('ada');
      const moderator = await admin('mod@example.com', 'moderator');
      for (let i = 0; i < 26; i += 1) {
        const other = await person(`user${String(i).padStart(2, '0')}`);
        t.clock.advance(1_000);
        await report(ada, other, 'bio').expect(201);
        await report(ada, other, 'username').expect(201);
      }
      const first = (await t.http().get('/admin/reports').set(moderator).expect(200)).body as {
        items: Body[];
        nextCursor: string;
      };
      expect(first.items).toHaveLength(50);
      const second = (
        await t
          .http()
          .get('/admin/reports')
          .query({ cursor: first.nextCursor })
          .set(moderator)
          .expect(200)
      ).body as { items: Body[]; nextCursor: string | null };
      expect(second.items).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map((item) => item['id'])).size).toBe(52);
      await t.http().get('/admin/reports').query({ cursor: 'bad' }).set(moderator).expect(400);
    });

    it('shows one report with the target’s profile now, blocks between them, and history', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const moderator = await admin('mod@example.com', 'moderator');
      await t.http().put(`/me/blocks/${bob.userId}`).set(ada.auth).expect(204);
      const created = (await report(ada, bob, 'bio').expect(201)).body as { id: string };

      const res = await t.http().get(`/admin/reports/${created.id}`).set(moderator).expect(200);
      expect(res.body).toMatchObject({
        id: created.id,
        status: 'open',
        targetProfile: { username: 'bob', displayName: 'bob', bio: 'bob bio', avatarUrl: null },
        blocks: { reporterBlocksTarget: true, targetBlocksReporter: false },
        targetHistory: { reports: 1, warnings: 0, status: 'active' },
        reviewedBy: null,
        resolution: null,
      });
      await t
        .http()
        .get('/admin/reports/0199c000-0000-7000-8000-000000000000')
        .set(moderator)
        .expect(404);
    });

    it('keeps a report after its reporter deletes their account', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const moderator = await admin('mod@example.com', 'moderator');
      await report(ada, bob, 'bio').expect(201);
      await t.prisma.user.delete({ where: { id: ada.userId } });
      const res = await t.http().get('/admin/reports').set(moderator).expect(200);
      expect((res.body as { items: Body[] }).items[0]).toMatchObject({ reporter: null });
      await t.prisma.user.delete({ where: { id: bob.userId } });
      expect(await t.prisma.report.count()).toBe(0);
    });
  });

  describe('working a report', () => {
    async function setup() {
      const ada = await person('ada');
      const bob = await person('bob');
      const moderator = await admin('mod@example.com', 'moderator');
      const created = (await report(ada, bob, 'bio', 'Rude').expect(201)).body as { id: string };
      const path = `/admin/reports/${created.id}`;
      return { ada, bob, moderator, id: created.id, path };
    }
    const resolve = (auth: Auth, path: string, body: Body) =>
      t.http().post(`${path}/resolve`).set(auth).send(body);

    it('moves open → in review → resolved, audited, and refuses changing a closed report', async () => {
      const { bob, moderator, id, path } = await setup();
      const reviewed = await t.http().post(`${path}/review`).set(moderator).expect(200);
      expect(reviewed.body).toMatchObject({ status: 'in_review', reviewedBy: 'mod@example.com' });
      const again = await t.http().post(`${path}/review`).set(moderator).expect(409);
      expect(again.body).toMatchObject({ code: 'report_not_open' });

      t.clock.advance(60_000);
      const done = await resolve(moderator, path, {
        action: 'reset_bio',
        reason: 'Insults',
      }).expect(200);
      expect(done.body).toMatchObject({
        status: 'resolved',
        resolution: {
          action: 'reset_bio',
          reason: 'Insults',
          resolvedBy: 'mod@example.com',
          resolvedAt: '2026-10-09T10:01:00.000Z',
        },
      });
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: bob.userId } })).bio).toBeNull();
      const closed = await resolve(moderator, path, { action: 'none', reason: 'again' }).expect(
        409,
      );
      expect(closed.body).toMatchObject({ code: 'report_closed' });
      await t.http().post(`${path}/dismiss`).set(moderator).send({ reason: 'x y z' }).expect(409);
      // The resolution and its effect share one transaction and one timestamp.
      const entries = await audit();
      expect(entries[0]).toEqual(['report.review', 'report', id, null]);
      expect(entries.slice(1)).toHaveLength(2);
      expect(entries.slice(1)).toEqual(
        expect.arrayContaining([
          ['report.resolve', 'report', id, 'Insults'],
          ['user.reset_bio', 'user', bob.userId, 'Insults'],
        ]),
      );
    });

    it('dismisses a report without touching the user', async () => {
      const { bob, moderator, id, path } = await setup();
      const res = await t
        .http()
        .post(`${path}/dismiss`)
        .set(moderator)
        .send({ reason: 'Not abusive' })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'dismissed',
        resolution: { action: null, reason: 'Not abusive' },
      });
      expect(await t.prisma.user.findUniqueOrThrow({ where: { id: bob.userId } })).toMatchObject({
        bio: 'bob bio',
        status: 'active',
      });
      expect(await audit()).toEqual([['report.dismiss', 'report', id, 'Not abusive']]);
    });

    it('resets a username or an avatar', async () => {
      const { bob, moderator, path } = await setup();
      await resolve(moderator, path, { action: 'reset_username', reason: 'Slur' }).expect(200);
      expect(
        (await t.prisma.user.findUniqueOrThrow({ where: { id: bob.userId } })).username,
      ).toBeNull();
      // The name is free again, and bob can choose a new one.
      await t.http().patch('/me/profile').set(bob.auth).send({ username: 'bob' }).expect(200);

      const ada = await person('ada2');
      const second = (await report(ada, bob, 'avatar').expect(201)).body as { id: string };
      await t.prisma.user.update({
        where: { id: bob.userId },
        data: { avatarUrl: 'https://x/y.png' },
      });
      await resolve(moderator, `/admin/reports/${second.id}`, {
        action: 'reset_avatar',
        reason: 'Offensive image',
      }).expect(200);
      expect(
        (await t.prisma.user.findUniqueOrThrow({ where: { id: bob.userId } })).avatarUrl,
      ).toBeNull();
    });

    it('warns with a message the user reads and acknowledges', async () => {
      const { bob, moderator, path } = await setup();
      const missing = await resolve(moderator, path, { action: 'warn', reason: 'Rude' }).expect(
        422,
      );
      expect(missing.body).toMatchObject({ code: 'warning_message_required' });
      await resolve(moderator, path, {
        action: 'warn',
        reason: 'Rude bio, first time',
        message: 'Please keep your bio kind.',
      }).expect(200);

      const list = (await t.http().get('/me/warnings').set(bob.auth).expect(200)).body as {
        items: Body[];
      };
      expect(list.items).toEqual([
        {
          id: expect.any(String) as string,
          message: 'Please keep your bio kind.',
          createdAt: '2026-10-09T10:00:00.000Z',
          acknowledgedAt: null,
        },
      ]);
      const warningId = list.items[0]!['id'] as string;
      t.clock.advance(5_000);
      const ack = await t
        .http()
        .put(`/me/warnings/${warningId}/acknowledged`)
        .set(bob.auth)
        .expect(200);
      expect(ack.body).toMatchObject({ acknowledgedAt: '2026-10-09T10:00:05.000Z' });
      t.clock.advance(5_000);
      await t.http().put(`/me/warnings/${warningId}/acknowledged`).set(bob.auth).expect(200);
      expect(
        (await t.prisma.userWarning.findUniqueOrThrow({ where: { id: warningId } })).acknowledgedAt,
      ).toEqual(new Date('2026-10-09T10:00:05.000Z'));
      const other = await person('cyd');
      await t.http().put(`/me/warnings/${warningId}/acknowledged`).set(other.auth).expect(404);
      expect(
        ((await t.http().get('/me/warnings').set(other.auth).expect(200)).body as Body)['items'],
      ).toEqual([]);
    });

    it('suspends or bans: sign-in ends at once; only an admin lifts it', async () => {
      const { ada, bob, moderator, path } = await setup();
      await resolve(moderator, path, { action: 'suspend', reason: 'Harassment' }).expect(200);
      expect(await t.prisma.user.findUniqueOrThrow({ where: { id: bob.userId } })).toMatchObject({
        status: 'suspended',
      });
      await t.http().get('/me/profile').set(bob.auth).expect(401);
      expect(
        await t.prisma.refreshToken.count({ where: { userId: bob.userId, revokedAt: null } }),
      ).toBe(0);

      const second = (await report(ada, bob, 'behavior').expect(201)).body as { id: string };
      const already = await resolve(moderator, `/admin/reports/${second.id}`, {
        action: 'suspend',
        reason: 'Again',
      }).expect(409);
      expect(already.body).toMatchObject({ code: 'already_suspended' });
      await resolve(moderator, `/admin/reports/${second.id}`, {
        action: 'ban',
        reason: 'Repeated harassment',
      }).expect(200);
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: bob.userId } })).status).toBe(
        'banned',
      );
      await t
        .http()
        .post('/auth/sign-in')
        .send({ email: 'bob@example.com', password: 'correct horse battery staple' })
        .expect(403)
        .expect((res) => expect(res.body).toMatchObject({ message: 'This account is banned.' }));

      const boss = await admin('boss@example.com', 'admin');
      const lifted = await t
        .http()
        .post(`/admin/users/${bob.userId}/reactivate`)
        .set(boss)
        .send({ reason: 'Appeal accepted' })
        .expect(200);
      expect(lifted.body).toMatchObject({ status: 'active', username: 'bob' });
    });

    it('bans a user who is already banned only once', async () => {
      const { ada, bob, moderator, path } = await setup();
      await resolve(moderator, path, { action: 'ban', reason: 'Spam' }).expect(200);
      const second = (await report(ada, bob, 'username').expect(201)).body as { id: string };
      const res = await resolve(moderator, `/admin/reports/${second.id}`, {
        action: 'ban',
        reason: 'Spam',
      }).expect(409);
      expect(res.body).toMatchObject({ code: 'already_banned' });
      expect((await t.prisma.report.findUniqueOrThrow({ where: { id: second.id } })).status).toBe(
        'open',
      );
    });

    it('validates actions and reasons', async () => {
      const { moderator, path } = await setup();
      await resolve(moderator, path, { action: 'delete', reason: 'Spam' }).expect(400);
      await resolve(moderator, path, { action: 'none', reason: 'x' }).expect(400);
      await resolve(moderator, path, { action: 'none' }).expect(400);
      await t.http().post(`${path}/dismiss`).set(moderator).send({}).expect(400);
    });

    it('resolves a report once when two moderators race', async () => {
      const { bob, path } = await setup();
      const one = await admin('one@example.com', 'moderator');
      const two = await admin('two@example.com', 'moderator');
      const results = await Promise.all([
        resolve(one, path, { action: 'warn', reason: 'Rude', message: 'Be kind.' }),
        resolve(two, path, { action: 'warn', reason: 'Rude', message: 'Be kind.' }),
      ]);
      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(await t.prisma.userWarning.count({ where: { userId: bob.userId } })).toBe(1);
    });
  });

  describe('admin user context', () => {
    it('shows the username, reports, warnings, and blocks of a user, and finds them by username', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const support = await admin('support@example.com', 'support');
      const moderator = await admin('mod@example.com', 'moderator');
      await t.http().put(`/me/blocks/${bob.userId}`).set(ada.auth).expect(204);
      const created = (await report(ada, bob, 'bio').expect(201)).body as { id: string };
      await report(bob, ada, 'username').expect(201);
      await t
        .http()
        .post(`/admin/reports/${created.id}/resolve`)
        .set(moderator)
        .send({ action: 'warn', reason: 'Rude', message: 'Be kind.' })
        .expect(200);

      const detail = (await t.http().get(`/admin/users/${bob.userId}`).set(support).expect(200))
        .body as Body;
      expect(detail['profile']).toMatchObject({ username: 'bob' });
      expect(detail['moderation']).toEqual({
        reportsAbout: 1,
        openReportsAbout: 0,
        reportsFiled: 1,
        warnings: 1,
        blocking: 0,
        blockedBy: 1,
      });
      // A username unlike the email and the display name, so only the username matches.
      await t.http().patch('/me/profile').set(bob.auth).send({ username: 'zed_moon' }).expect(200);
      const found = (
        await t.http().get('/admin/users').query({ q: 'ZED_M' }).set(support).expect(200)
      ).body as { items: Body[] };
      expect(found.items.map((row) => row['username'])).toEqual(['zed_moon']);
      const dashboard = (await t.http().get('/admin/dashboard').set(support).expect(200))
        .body as Body;
      expect(dashboard).toMatchObject({ openReports: 1 });
    });
  });
});
