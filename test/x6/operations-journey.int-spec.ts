import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';
import { normalize } from '../support/contract-normalize.js';

/**
 * X6 Operations integration (HTTP + PostgreSQL): the admin runs live content and configuration
 * over the real API, and the app sees exactly that.
 *
 * 1. A content admin creates badges, an event with missions and a Community Tree, and a winter
 *    theme; the app serves them; once someone joins, what they joined is locked.
 * 2. An admin activates a configuration version with a lower daily soft cap. Archived trees and
 *    the month in progress keep the version they grew under; next month's tree uses it.
 * 3. A compensation grant appears in the person's collection.
 * 4. Every Phase 6 admin answer the admin app reads is captured (`operations-contract.json`,
 *    byte-identical with focus-forest-admin `src/test/operations-contract.json`). After an
 *    intended change: `X6_UPDATE_CONTRACT=1 npm run test:int -- test/x6`, then copy the file.
 */

const FILE = fileURLToPath(new URL('./operations-contract.json', import.meta.url));
const t = new ConsistencyHarness('2026-10-15T08:00:00.000Z');
const PASSWORD = 'correct horse battery staple admin';
const hasher = new PasswordHasher({ cost: 2 ** 10 });
type Auth = Record<string, string>;
type Body = Record<string, unknown>;
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

async function signIn(email: string): Promise<Auth> {
  const res = await t
    .http()
    .post('/admin/auth/sign-in')
    .send({ email, password: PASSWORD })
    .expect(200);
  return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
}

const badge = (id: string, source: 'event' | 'season', from: string, until: string) => ({
  id,
  category: source === 'event' ? 'event' : 'rare',
  rarity: 'common',
  source,
  availability: 'limited',
  availableFrom: from,
  availableUntil: until,
  status: 'active',
  name: id,
  description: `The ${id} badge.`,
  artworkId: id.replace(':', '-'),
  sortOrder: 300,
  reason: 'November content',
});

const EVENT = {
  id: 'november-sprint',
  name: 'November Sprint',
  description: 'Steady focus through November.',
  artworkId: 'november-sprint',
  status: 'active',
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2026-11-21T00:00:00.000Z',
  entryMinSessions: 0,
  leaderboard: true,
  teams: [],
  missions: [
    {
      id: 'three-hours',
      measure: 'focus_minutes',
      target: 180,
      dailyMinutes: 0,
      name: 'Focus 3 hours',
      description: 'Three hours of focus.',
    },
  ],
  milestones: [
    {
      id: 'steady',
      name: 'Steady',
      requiredMissions: 1,
      badgeId: 'november-sprint:steady',
      trait: false,
    },
  ],
  communityTree: {
    name: 'The November Oak',
    artworkId: 'november-oak',
    milestones: [{ stage: 'seedling', thresholdMinutes: 240, badgeId: 'november-sprint:oak' }],
  },
  reason: 'November event',
};

const THEME = {
  id: 'winter-x6',
  name: 'Winter',
  description: 'Snow settles softly.',
  environmentId: 'winter',
  hemisphere: 'north',
  status: 'active',
  startsAt: '2026-12-01T00:00:00.000Z',
  endsAt: '2027-03-01T00:00:00.000Z',
  rewards: [{ id: 'first-snow', badgeId: 'season:winter-x6', requiredActiveDays: 1 }],
  reason: 'Winter theme',
};

describe('X6 operations integration (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-15T08:00:00.000Z');
    await t.activateConfig();
  });

  it('runs live content and configuration that the app then follows', async () => {
    const c: Record<string, unknown> = {};
    const app = async <T = Body>(user: User, path: string) =>
      (await t.http().get(path).set(user.auth).expect(200)).body as T;
    const staff = async (
      auth: Auth,
      method: 'get' | 'post' | 'patch',
      path: string,
      body?: object,
      status = 200,
    ) =>
      (
        await t
          .http()
          [method](path)
          .set(auth)
          .send(body ?? {})
          .expect(status)
      ).body as Body;
    const growthMinutes = async (user: User) =>
      (await app<{ tree: { progress: { growthMinutes: number } } }>(user, '/me/trees/current')).tree
        .progress.growthMinutes;
    const tree = (userId: string, month: number) =>
      t.prisma.monthlyTree.findFirstOrThrow({ where: { userId, year: 2026, month } });

    // October: Ana grows a tree, which November archives.
    const ana = await t.signUp('ana@example.com', 'UTC', '2026-09-01T00:00:00.000Z');
    // Her phone, and what she turned on (read back by the notification diagnostics).
    await t
      .http()
      .put(`/me/devices/${encodeURIComponent('ExponentPushToken[ana-phone-1234]')}`)
      .set(ana.auth)
      .send({ platform: 'android', appVersion: '1.0.0' })
      .expect(200);
    await t
      .http()
      .patch('/me/preferences')
      .set(ana.auth)
      .send({
        notifications: {
          dailyGoalReminder: { enabled: true, time: '19:00' },
          badgeUnlocked: { enabled: true },
        },
      })
      .expect(200);
    await t.setNow('2026-10-15T11:05:00.000Z');
    await t.submit(ana, '2026-10-15T10:00:00.000Z', 60).expect(201);

    await createAdmin(t.prisma, hasher, {
      email: 'content@example.com',
      role: 'content',
      password: PASSWORD,
    });
    await createAdmin(t.prisma, hasher, {
      email: 'admin@example.com',
      role: 'admin',
      password: PASSWORD,
    });

    // 1. November: the content admin creates the badges, the event, and the winter theme.
    await t.setNow('2026-11-02T09:00:00.000Z');
    let content = await signIn('content@example.com');
    for (const body of [
      badge(
        'november-sprint:steady',
        'event',
        '2026-11-01T00:00:00.000Z',
        '2026-12-31T00:00:00.000Z',
      ),
      badge('november-sprint:oak', 'event', '2026-11-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z'),
      badge('season:winter-x6', 'season', '2026-12-01T00:00:00.000Z', '2027-04-01T00:00:00.000Z'),
      badge('october-marathon', 'event', '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z'),
    ]) {
      await staff(content, 'post', '/admin/content/badges', body, 201);
    }
    // October's event is over: its badge is retired (an outage kept Ana from earning it).
    await staff(content, 'patch', '/admin/content/badges/october-marathon', {
      status: 'retired',
      reason: 'October is over',
    });
    await staff(content, 'post', '/admin/live/events', EVENT, 201);
    await staff(content, 'post', '/admin/live/themes', THEME, 201);
    c['catalog'] = await staff(content, 'get', '/admin/content/badges');
    c['themes'] = await staff(content, 'get', '/admin/live/themes');

    // The app serves the event; Ana joins it, and focuses 5 hours.
    const events = await app<{ items: { id: string }[] }>(ana, '/events');
    expect(events.items.map((event) => event.id)).toContain('november-sprint');
    await t.http().post('/events/november-sprint/join').set(ana.auth).expect(200);
    await t.setNow('2026-11-02T15:05:00.000Z');
    await t.submit(ana, '2026-11-02T10:00:00.000Z', 300).expect(201);
    // Under the active rules (soft cap 240, 40% beyond): 240 + 60 × 40% = 264.
    expect(await growthMinutes(ana)).toBe(264);

    // What Ana joined is locked; the name stays open.
    content = await signIn('content@example.com');
    const locked = await staff(
      content,
      'patch',
      '/admin/live/events/november-sprint',
      { missions: [{ ...EVENT.missions[0], target: 120 }], reason: 'Shorter mission' },
      422,
    );
    expect(locked['problems']).toEqual(['missions is locked: people have taken part.']);
    c['eventLocked'] = locked;
    await staff(content, 'patch', '/admin/live/events/november-sprint', {
      name: 'The November Sprint',
      reason: 'Clearer name',
    });
    c['event'] = await staff(content, 'get', '/admin/live/events/november-sprint');
    expect(c['event']).toMatchObject({
      name: 'The November Sprint',
      participants: 1,
      locked: true,
      communityTree: { totalMinutes: 300, contributors: 1 },
    });
    c['board'] = await staff(
      content,
      'get',
      '/admin/live/leaderboards?scope=event&eventId=november-sprint',
    );
    c['exclusions'] = await staff(content, 'get', '/admin/live/leaderboard-exclusions');

    // 2. The admin lowers the daily soft cap in a new configuration version and activates it.
    const october = await tree(ana.userId, 10);
    const november = await tree(ana.userId, 11);
    expect(october.status).toBe('archived');
    const admin = await signIn('admin@example.com');
    c['versions'] = await staff(admin, 'get', '/admin/config/versions');
    const active = (c['versions'] as { items: { version: number; active: boolean }[] }).items.find(
      (row) => row.active,
    )!.version;
    const current = await staff(admin, 'get', `/admin/config/versions/${active}`);
    const proposed = await staff(
      admin,
      'post',
      '/admin/config/versions',
      {
        values: { ...(current['values'] as Body), 'growth.dailySoftCap': 120 },
        note: 'A lower daily soft cap.',
        reason: 'Long days grew trees too fast',
      },
      201,
    );
    const version = proposed['version'] as number;
    c['diff'] = await staff(admin, 'get', `/admin/config/versions/${version}/diff`);
    expect((c['diff'] as { changes: unknown[] }).changes).toEqual([
      { key: 'growth.dailySoftCap', active: 240, proposed: 120 },
    ]);
    c['preview'] = await staff(admin, 'get', `/admin/config/versions/${version}/preview`);
    c['activated'] = await staff(admin, 'post', `/admin/config/versions/${version}/activate`, {
      reason: 'Long days grew trees too fast',
    });

    // Never retroactive: the archived month and the month in progress keep their version.
    expect(await tree(ana.userId, 10)).toEqual(october);
    expect((await tree(ana.userId, 11)).configVersion).toBe(november.configVersion);

    // The month in progress keeps growing under its own version: five more hours add 264.
    await t.setNow('2026-11-03T15:05:00.000Z');
    await t.submit(ana, '2026-11-03T10:00:00.000Z', 300).expect(201);
    expect(await growthMinutes(ana)).toBe(528);

    // December: the same five hours now grow 120 + 180 × 40% = 192 minutes.
    await t.setNow('2026-12-02T15:05:00.000Z');
    await t.submit(ana, '2026-12-02T10:00:00.000Z', 300).expect(201);
    expect(await growthMinutes(ana)).toBe(192);
    expect((await tree(ana.userId, 12)).configVersion).toBe(version);
    // The winter theme is served in its season.
    expect(await app(ana, '/me/season')).toMatchObject({ theme: { id: 'winter-x6' } });

    // 3. A compensation grant appears in Ana's collection.
    const granter = await signIn('admin@example.com');
    c['granted'] = await staff(
      granter,
      'post',
      `/admin/users/${ana.userId}/grants`,
      { kind: 'badge', itemId: 'october-marathon', reason: 'Missed by the outage' },
      201,
    );
    const collection = await app<{
      sections: { kind: string; items: { id: string; owned: boolean }[] }[];
    }>(ana, '/me/collection');
    const badges = collection.sections.find((section) => section.kind === 'badges')!;
    expect(badges.items.find((item) => item.id === 'october-marathon')).toMatchObject({
      owned: true,
    });
    c['diagnostics'] = await staff(granter, 'get', `/admin/users/${ana.userId}/notifications`);
    expect(c['diagnostics']).toMatchObject({
      devices: [{ token: 'ExponentPushToken[ana…234]', platform: 'android' }],
      // In the spec's category order.
      enabled: [
        { category: 'dailyGoalReminder', time: '19:00' },
        { category: 'badgeUnlocked', time: null },
      ],
    });
    c['auditFiltered'] = await staff(granter, 'get', '/admin/audit-log?action=user.grant');
    expect((c['auditFiltered'] as { items: Body[] }).items).toEqual([
      expect.objectContaining({ action: 'user.grant', reason: 'Missed by the outage' }),
    ]);

    // 4. The capture.
    const adminIds = await t.prisma.adminUser.findMany({ select: { id: true, email: true } });
    const replace = new Map<string, string>([[ana.userId, '00000000-0000-4000-8000-0000000006d1']]);
    for (const row of adminIds) {
      replace.set(row.id, row.email === 'admin@example.com' ? 'admin-x6' : 'content-x6');
    }
    const audit = (c['auditFiltered'] as { items: { id: string }[] }).items;
    audit.forEach((entry, i) => replace.set(entry.id, `audit-x6-${i + 1}`));
    const captured = `${JSON.stringify(normalize(c, replace, new Map()), null, 2)}\n`;
    expect(captured).not.toMatch(/eyJ|password/);
    if (process.env['X6_UPDATE_CONTRACT'] === '1' || !existsSync(FILE)) {
      writeFileSync(FILE, captured);
    }
    expect(captured).toBe(readFileSync(FILE, 'utf8'));
    // Two months of growth and a run of admin work: give a busy machine room.
  }, 120_000);
});
