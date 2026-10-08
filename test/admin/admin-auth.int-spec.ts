import { randomUUID } from 'node:crypto';

import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * CR.3 early admin foundation over HTTP + PostgreSQL: admins apart from app users, sign-in,
 * tokens that never cross with app tokens, roles read from the database on every request, and an
 * append-only audit log.
 */

const t = new ConsistencyHarness('2026-10-08T12:00:00.000Z');
const PASSWORD = 'correct horse battery staple admin';
const hasher = new PasswordHasher({ cost: 2 ** 10 });

async function admin(email: string, role: 'admin' | 'support' = 'admin') {
  const created = await createAdmin(t.prisma, hasher, { email, role, password: PASSWORD });
  const res = await t
    .http()
    .post('/admin/auth/sign-in')
    .send({ email, password: PASSWORD })
    .expect(200);
  const body = res.body as { accessToken: string };
  return { ...created, auth: { Authorization: `Bearer ${body.accessToken}` } };
}

describe('admin foundation (CR.3, HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-08T12:00:00.000Z');
    await t.activateConfig();
  });

  describe('bootstrap', () => {
    it('creates an admin with a lowercased email, and refuses bad input or a duplicate', async () => {
      const created = await createAdmin(t.prisma, hasher, {
        email: ' Ops@Example.com ',
        role: 'admin',
        password: PASSWORD,
      });
      expect(created).toMatchObject({ email: 'ops@example.com', role: 'admin' });
      const stored = await t.prisma.adminUser.findUniqueOrThrow({ where: { id: created.id } });
      expect(stored.passwordHash).not.toContain(PASSWORD);
      const attempt = (input: Partial<Parameters<typeof createAdmin>[2]>) =>
        createAdmin(t.prisma, hasher, {
          email: 'new@example.com',
          role: 'support',
          password: PASSWORD,
          ...input,
        });
      await expect(attempt({ email: 'ops@example.com' })).rejects.toThrow(/already exists/);
      await expect(attempt({ role: 'owner' })).rejects.toThrow(/role must be one of/);
      await expect(attempt({ password: 'short' })).rejects.toThrow(/12 characters/);
      await expect(attempt({ email: 'not-an-email' })).rejects.toThrow(/valid email/);
    });
  });

  describe('sign-in', () => {
    it('signs an admin in, records it, and answers who is signed in', async () => {
      const ops = await admin('ops@example.com');
      const me = await t.http().get('/admin/auth/me').set(ops.auth).expect(200);
      expect(me.body).toEqual({ id: ops.id, email: 'ops@example.com', role: 'admin' });
      const stored = await t.prisma.adminUser.findUniqueOrThrow({ where: { id: ops.id } });
      expect(stored.lastSignInAt).toEqual(new Date('2026-10-08T12:00:00.000Z'));
      expect(
        (await t.prisma.adminAuditLog.findMany()).map((row) => [row.adminId, row.action]),
      ).toEqual([[ops.id, 'admin.sign_in']]);
    });

    it('refuses wrong credentials, unknown and disabled admins alike, and app users', async () => {
      await admin('ops@example.com');
      const refused = async (email: string, password = PASSWORD) =>
        (await t.http().post('/admin/auth/sign-in').send({ email, password }).expect(401)).body as {
          message: string;
        };
      expect((await refused('ops@example.com', 'wrong password!!')).message).toBe(
        'Email or password is incorrect.',
      );
      expect((await refused('nobody@example.com')).message).toBe('Email or password is incorrect.');
      await t.prisma.adminUser.update({
        where: { email: 'ops@example.com' },
        data: { status: 'disabled' },
      });
      await refused('ops@example.com');
      // An app user is not an admin, whatever their password.
      await t.signUp('ada@example.com', 'UTC');
      await refused('ada@example.com', 'correct horse battery staple');
    });
  });

  describe('tokens and roles', () => {
    it('never accepts an app token on admin routes, nor an admin token on app routes', async () => {
      const ops = await admin('ops@example.com');
      const ada = await t.signUp('ada@example.com', 'UTC');
      await t.http().get('/admin/auth/me').set(ada.auth).expect(401);
      await t.http().get('/admin/auth/me').expect(401);
      await t.http().get('/me/profile').set(ops.auth).expect(401);
      await t.http().get('/me/profile').set(ada.auth).expect(200);
    });

    it('expires admin tokens, and stops a disabled admin at once', async () => {
      const ops = await admin('ops@example.com');
      await t.setNow('2026-10-08T12:29:00.000Z');
      await t.http().get('/admin/auth/me').set(ops.auth).expect(200);
      await t.setNow('2026-10-08T12:31:00.000Z');
      await t.http().get('/admin/auth/me').set(ops.auth).expect(401);

      await t.setNow('2026-10-08T12:00:00.000Z');
      const helper = await admin('helper@example.com', 'support');
      await t.prisma.adminUser.update({ where: { id: helper.id }, data: { status: 'disabled' } });
      await t.http().get('/admin/auth/me').set(helper.auth).expect(401);
    });

    it('keeps admin-only routes from support, reading the role on every request', async () => {
      const helper = await admin('helper@example.com', 'support');
      const forbidden = await t.http().get('/admin/audit-log').set(helper.auth).expect(403);
      expect(forbidden.body).toMatchObject({ code: 'admin_role_forbidden' });
      await t.prisma.adminUser.update({ where: { id: helper.id }, data: { role: 'admin' } });
      await t.http().get('/admin/audit-log').set(helper.auth).expect(200);
    });
  });

  describe('audit log', () => {
    it('lists entries newest first, page by page, with who did them', async () => {
      const ops = await admin('ops@example.com');
      for (let i = 0; i < 55; i += 1) {
        await t.setNow(new Date(Date.parse('2026-10-08T12:01:00.000Z') + i * 1000).toISOString());
        await t.prisma.adminAuditLog.create({
          data: {
            id: randomUUID(),
            adminId: ops.id,
            action: 'test.entry',
            targetType: 'user',
            targetId: String(i),
            createdAt: new Date(Date.parse('2026-10-08T12:01:00.000Z') + i * 1000),
          },
        });
      }
      await t.setNow('2026-10-08T12:10:00.000Z');
      const auth = (await admin('second@example.com')).auth;
      type Page = {
        items: { targetId: string | null; admin: { email: string } }[];
        nextCursor: string | null;
      };
      const first = (await t.http().get('/admin/audit-log').set(auth).expect(200)).body as Page;
      expect(first.items).toHaveLength(50);
      expect(first.items[0]).toMatchObject({
        targetId: null,
        admin: { email: 'second@example.com' },
      });
      expect(first.items[1]).toMatchObject({ targetId: '54', admin: { email: 'ops@example.com' } });
      const second = (
        await t.http().get(`/admin/audit-log?cursor=${first.nextCursor}`).set(auth).expect(200)
      ).body as Page;
      expect(second.items.map((item) => item.targetId)).toEqual([
        '5',
        '4',
        '3',
        '2',
        '1',
        '0',
        null,
      ]);
      expect(second.nextCursor).toBeNull();
      await t.http().get('/admin/audit-log?cursor=nonsense').set(auth).expect(400);
    });

    it('is append-only in the database', async () => {
      const ops = await admin('ops@example.com');
      const row = await t.prisma.adminAuditLog.findFirstOrThrow({ where: { adminId: ops.id } });
      await expect(
        t.prisma.adminAuditLog.update({ where: { id: row.id }, data: { reason: 'edited' } }),
      ).rejects.toThrow(/append-only/);
      await expect(t.prisma.adminAuditLog.delete({ where: { id: row.id } })).rejects.toThrow(
        /append-only/,
      );
    });
  });
});
