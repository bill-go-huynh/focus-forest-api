import { randomUUID } from 'node:crypto';

import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';
import { configValues } from '../support/product-config-values.js';

/**
 * A6.6 configuration versions and operations (docs/09 later admin: "Product configuration:
 * propose a new version, preview its effect on sample months, activate"; "compensation grants
 * after incidents (always logged)"; audit log filterable by admin, action, target), and the
 * notification diagnostics support needs. Versions never change archived trees.
 */

const t = new ConsistencyHarness('2026-11-02T10:00:00.000Z');
const PASSWORD = 'correct horse battery staple admin';
const hasher = new PasswordHasher({ cost: 2 ** 10 });
type Body = Record<string, unknown>;
type Role = 'admin' | 'support' | 'moderator' | 'content';

async function admin(email: string, role: Role) {
  await createAdmin(t.prisma, hasher, { email, role, password: PASSWORD });
  const res = await t.http().post('/admin/auth/sign-in').send({ email, password: PASSWORD });
  return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
}
const audit = async () =>
  (await t.prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'asc' } }))
    .filter((row) => row.action !== 'admin.sign_in')
    .map((row) => [row.action, row.targetId, row.reason, row.details]);

const PROPOSAL = {
  // What the tests run with (`configValues`), the soft cap lowered.
  values: configValues({ 'growth.dailySoftCap': 120 }),
  note: 'A lower daily soft cap.',
  reason: 'Long days were growing trees too fast',
};

describe('configuration versions and operations (A6.6)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.activateConfig();
    await t.setNow('2026-11-02T10:00:00.000Z');
  });

  describe('configuration versions', () => {
    it('proposes, diffs, previews, and activates a version, without touching archived trees', async () => {
      const auth = await admin('admin@example.com', 'admin');
      const active = (await t.prisma.activeProductConfig.findFirstOrThrow()).version;
      const ana = await t.signUp('ana@example.com');
      await t.submit(ana, '2026-11-02T09:00:00.000Z', 30).expect(201);
      const treeBefore = await t.prisma.monthlyTree.findFirstOrThrow({
        where: { userId: ana.userId },
      });

      const proposed = (
        await t.http().post('/admin/config/versions').set(auth).send(PROPOSAL).expect(201)
      ).body as Body;
      expect(proposed).toMatchObject({ note: 'A lower daily soft cap.', active: false });
      const version = proposed['version'] as number;
      expect(version).toBeGreaterThan(active);

      const list = (await t.http().get('/admin/config/versions').set(auth).expect(200)).body as {
        items: Body[];
      };
      expect(list.items[0]).toMatchObject({ version, active: false });
      expect(list.items.find((item) => item['version'] === active)).toMatchObject({ active: true });

      expect(
        (await t.http().get(`/admin/config/versions/${version}/diff`).set(auth).expect(200)).body,
      ).toEqual({
        against: active,
        changes: [{ key: 'growth.dailySoftCap', active: 240, proposed: 120 }],
      });
      const preview = (
        await t.http().get(`/admin/config/versions/${version}/preview`).set(auth).expect(200)
      ).body as { against: number; samples: Body[] };
      expect(preview.against).toBe(active);
      expect(preview.samples.map((sample) => sample['id'])).toEqual([
        'light',
        'steady',
        'deep',
        'first-month',
      ]);
      // Three hours a day grow less under a lower soft cap; half an hour is not touched.
      const sample = (id: string) =>
        preview.samples.find((s) => s['id'] === id) as {
          active: { growthMinutes: number };
          proposed: { growthMinutes: number };
        };
      expect(sample('deep').proposed.growthMinutes).toBeLessThan(
        sample('deep').active.growthMinutes,
      );
      expect(sample('steady').proposed).toEqual(sample('steady').active);

      await t
        .http()
        .post(`/admin/config/versions/${version}/activate`)
        .set(auth)
        .send({ reason: 'Approved after the preview' })
        .expect(200);
      expect((await t.prisma.activeProductConfig.findFirstOrThrow()).version).toBe(version);
      expect((await t.http().get('/admin/config').set(auth).expect(200)).body).toMatchObject({
        version,
      });
      // Activating is not retroactive: the stored tree keeps the version it grew under.
      expect(
        await t.prisma.monthlyTree.findUniqueOrThrow({
          where: {
            userId_year_month: {
              userId: ana.userId,
              year: treeBefore.year,
              month: treeBefore.month,
            },
          },
        }),
      ).toMatchObject({ configVersion: treeBefore.configVersion });
      await t
        .http()
        .post(`/admin/config/versions/${version}/activate`)
        .set(auth)
        .send({ reason: 'Again' })
        .expect(409);

      expect(await audit()).toEqual([
        [
          'config.propose',
          String(version),
          'Long days were growing trees too fast',
          { note: 'A lower daily soft cap.' },
        ],
        [
          'config.activate',
          String(version),
          'Approved after the preview',
          { from: active, to: version },
        ],
      ]);
    });

    it('refuses an incomplete or invalid version, saying why', async () => {
      const auth = await admin('admin@example.com', 'admin');
      const values: Record<string, unknown> = {
        ...configValues(),
        'growth.overCapRate': 140,
      };
      delete values['growth.dailySoftCap'];
      const res = await t
        .http()
        .post('/admin/config/versions')
        .set(auth)
        .send({ values, note: 'Broken', reason: 'Test' })
        .expect(422);
      expect(res.body).toMatchObject({ code: 'invalid_config' });
      const problems = (res.body as { problems: string[] }).problems;
      expect(problems.some((p) => p.includes('growth.dailySoftCap'))).toBe(true);
      expect(problems.some((p) => p.includes('growth.overCapRate'))).toBe(true);
      await t
        .http()
        .post('/admin/config/versions')
        .set(auth)
        .send({ values: PROPOSAL.values, note: '', reason: 'Test' })
        .expect(422);
      await t.http().get('/admin/config/versions/999/diff').set(auth).expect(404);
      expect(await audit()).toEqual([]);
    });

    it('leaves configuration to admins', async () => {
      for (const role of ['support', 'moderator', 'content'] as const) {
        const auth = await admin(`${role}@example.com`, role);
        await t.http().get('/admin/config/versions').set(auth).expect(403);
        await t.http().post('/admin/config/versions').set(auth).send(PROPOSAL).expect(403);
      }
    });
  });

  describe('compensation grants', () => {
    it('gives a badge a person missed, even after its window, once, and logs it', async () => {
      const auth = await admin('admin@example.com', 'admin');
      const ana = await t.signUp('ana@example.com');
      await t.prisma.badgeDefinition.create({
        data: {
          id: 'autumn-2025:steady',
          category: 'event',
          rarity: 'common',
          source: 'season',
          availability: 'limited',
          status: 'retired',
          availableFrom: new Date('2025-10-01T00:00:00Z'),
          availableUntil: new Date('2025-11-15T00:00:00Z'),
          name: 'Steady 2025',
          description: 'A past seasonal badge.',
          artworkId: 'autumn-2025-steady',
        },
      });
      const grant = (body: Body) =>
        t.http().post(`/admin/users/${ana.userId}/grants`).set(auth).send(body);

      expect(
        (
          await grant({
            kind: 'badge',
            itemId: 'autumn-2025:steady',
            reason: 'Lost to the sync bug',
          }).expect(201)
        ).body,
      ).toEqual({
        kind: 'badge',
        itemId: 'autumn-2025:steady',
        grantedAt: '2026-11-02T10:00:00.000Z',
      });
      expect(await t.prisma.userBadge.count({ where: { userId: ana.userId } })).toBe(1);
      expect(
        (await grant({ kind: 'badge', itemId: 'autumn-2025:steady', reason: 'Again' }).expect(409))
          .body,
      ).toMatchObject({
        code: 'already_owned',
      });
      // System content is everyone's already; planned content is not out yet.
      await grant({ kind: 'cosmetic', itemId: 'meadow', reason: 'Test' }).expect(422);
      await t.prisma.cosmeticDefinition.create({
        data: {
          id: 'future-lamp',
          type: 'decoration',
          rarity: 'common',
          source: 'season',
          availability: 'permanent',
          status: 'planned',
          name: 'Future Lamp',
          description: 'Not out yet.',
          artworkId: 'future-lamp',
        },
      });
      await grant({ kind: 'cosmetic', itemId: 'future-lamp', reason: 'Test' }).expect(422);
      await grant({ kind: 'species', itemId: 'no-such-tree', reason: 'Test' }).expect(404);
      await grant({ kind: 'hat', itemId: 'x', reason: 'Test' }).expect(422);
      await t
        .http()
        .post(`/admin/users/${randomUUID()}/grants`)
        .set(auth)
        .send({ kind: 'species', itemId: 'oak', reason: 'Test' })
        .expect(404);
      await grant({ kind: 'species', itemId: 'oak', reason: 'Support case 12' }).expect(201);

      expect(await audit()).toEqual([
        [
          'user.grant',
          ana.userId,
          'Lost to the sync bug',
          { kind: 'badge', itemId: 'autumn-2025:steady' },
        ],
        ['user.grant', ana.userId, 'Support case 12', { kind: 'species', itemId: 'oak' }],
      ]);
    });

    it('leaves grants to admins', async () => {
      const ana = await t.signUp('ana@example.com');
      for (const role of ['support', 'moderator', 'content'] as const) {
        const auth = await admin(`${role}@example.com`, role);
        await t
          .http()
          .post(`/admin/users/${ana.userId}/grants`)
          .set(auth)
          .send({ kind: 'species', itemId: 'oak', reason: 'Test' })
          .expect(403);
      }
    });
  });

  describe('the audit log', () => {
    it('filters by admin, action, target, and time', async () => {
      const boss = await admin('admin@example.com', 'admin');
      const ana = await t.signUp('ana@example.com');
      await t
        .http()
        .post(`/admin/users/${ana.userId}/grants`)
        .set(boss)
        .send({ kind: 'species', itemId: 'oak', reason: 'Case 1' })
        .expect(201);
      await t.setNow('2026-11-03T10:00:00.000Z');
      const later = await (async () => {
        const res = await t
          .http()
          .post('/admin/auth/sign-in')
          .send({ email: 'admin@example.com', password: PASSWORD });
        return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
      })();
      await t
        .http()
        .post(`/admin/users/${ana.userId}/suspend`)
        .set(later)
        .send({ reason: 'Abuse report' })
        .expect(200);

      const actions = async (query: string) =>
        (
          (await t.http().get(`/admin/audit-log?${query}`).set(later).expect(200)).body as {
            items: { action: string }[];
          }
        ).items.map((item) => item.action);
      expect(await actions('action=user.grant')).toEqual(['user.grant']);
      expect(await actions(`targetId=${ana.userId}`)).toEqual(['user.suspend', 'user.grant']);
      expect((await actions('from=2026-11-03T00:00:00.000Z')).sort()).toEqual([
        'admin.sign_in',
        'user.suspend',
      ]);
      expect((await actions('to=2026-11-03T00:00:00.000Z')).sort()).toEqual([
        'admin.sign_in',
        'user.grant',
      ]);
      const bossId = (await t.prisma.adminUser.findFirstOrThrow()).id;
      expect((await actions(`adminId=${bossId}&targetType=user`)).sort()).toEqual([
        'user.grant',
        'user.suspend',
      ]);
      // Another admin, who only signed in, did none of it.
      await admin('ops@example.com', 'support');
      const ops = await t.prisma.adminUser.findFirstOrThrow({
        where: { email: 'ops@example.com' },
      });
      expect(await actions(`adminId=${ops.id}&targetType=user`)).toEqual([]);
      await t.http().get('/admin/audit-log?from=yesterday').set(later).expect(400);
    });
  });

  describe('notification diagnostics', () => {
    it('shows support a person’s devices, choices, focus, and what each notification became', async () => {
      const auth = await admin('support@example.com', 'support');
      const ana = await t.signUp('ana@example.com');
      await t
        .http()
        .put(`/me/devices/${encodeURIComponent('ExponentPushToken[abcdef123456]')}`)
        .set(ana.auth)
        .send({ platform: 'ios', appVersion: '1.4.0' })
        .expect(200);
      await t
        .http()
        .patch('/me/preferences')
        .set(ana.auth)
        .send({ notifications: { scheduledFocusReminder: { enabled: true, time: '08:30' } } })
        .expect(200);
      await t.prisma.notificationOutbox.create({
        data: {
          userId: ana.userId,
          category: 'badgeUnlocked',
          dedupeKey: 'badge:x',
          subject: 'x',
          title: 'A new badge: X',
          body: 'It is in your collection now.',
          link: '/',
          requested: false,
          notBefore: new Date('2026-11-02T09:00:00Z'),
          expiresAt: new Date('2026-11-03T09:00:00Z'),
          createdAt: new Date('2026-11-02T09:00:00Z'),
          status: 'skipped',
          reason: 'category_off',
        },
      });

      const body = (
        await t.http().get(`/admin/users/${ana.userId}/notifications`).set(auth).expect(200)
      ).body as Body;
      expect(body).toEqual({
        devices: [
          {
            token: 'ExponentPushToken[abc…456]',
            platform: 'ios',
            appVersion: '1.4.0',
            registeredAt: '2026-11-02T10:00:00.000Z',
            lastSeenAt: '2026-11-02T10:00:00.000Z',
          },
        ],
        focusUntil: null,
        enabled: [{ category: 'scheduledFocusReminder', time: '08:30' }],
        recent: [
          {
            category: 'badgeUnlocked',
            title: 'A new badge: X',
            status: 'skipped',
            reason: 'category_off',
            notBefore: '2026-11-02T09:00:00.000Z',
            sentAt: null,
          },
        ],
      });
      const moderator = await admin('moderator@example.com', 'moderator');
      await t.http().get(`/admin/users/${ana.userId}/notifications`).set(moderator).expect(403);
    });
  });
});
