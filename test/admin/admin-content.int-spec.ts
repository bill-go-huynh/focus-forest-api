import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A6.4 admin content catalog (docs/09 later admin: badges and achievements, tree variants,
 * cosmetics; docs/12 Phase 19: every content type managed without a deploy, every action
 * audited, roles restrict actions). Owned content is retired, never deleted; ids never change;
 * a definition anyone owns keeps the terms they earned it under.
 */

const t = new ConsistencyHarness('2026-11-02T10:00:00.000Z');
const PASSWORD = 'correct horse battery staple admin';
const hasher = new PasswordHasher({ cost: 2 ** 10 });
type Auth = Record<string, string>;
type Body = Record<string, unknown>;

async function admin(email: string, role: 'admin' | 'support' | 'moderator' | 'content') {
  await createAdmin(t.prisma, hasher, { email, role, password: PASSWORD });
  const res = await t.http().post('/admin/auth/sign-in').send({ email, password: PASSWORD });
  return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
}

const audit = async () =>
  (await t.prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'asc' } }))
    .filter((row) => row.action !== 'admin.sign_in')
    .map((row) => [row.action, row.targetId, row.reason, row.details]);

const BADGE = {
  id: 'deep-diver',
  category: 'focus',
  rarity: 'rare',
  source: 'achievement',
  availability: 'permanent',
  availableFrom: null,
  availableUntil: null,
  status: 'active',
  name: 'Deep Diver',
  description: 'Twenty long sessions.',
  artworkId: 'deep-diver',
  sortOrder: 200,
  reason: 'New long-session badge',
};

describe('admin content catalog (A6.4)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.activateConfig();
    await t.setNow('2026-11-02T10:00:00.000Z');
  });

  const post = (auth: Auth, kind: string, body: Body) =>
    t.http().post(`/admin/content/${kind}`).set(auth).send(body);
  const patch = (auth: Auth, kind: string, id: string, body: Body) =>
    t
      .http()
      .patch(`/admin/content/${kind}/${encodeURIComponent(id)}`)
      .set(auth)
      .send(body);
  const remove = (auth: Auth, kind: string, id: string, reason = 'Created by mistake') =>
    t
      .http()
      .delete(`/admin/content/${kind}/${encodeURIComponent(id)}`)
      .set(auth)
      .send({ reason });
  const get = async (auth: Auth, path: string) =>
    (await t.http().get(`/admin/content/${path}`).set(auth).expect(200)).body as Body;

  it('lists the catalog with how many people own each item', async () => {
    const auth = await admin('content@example.com', 'content');
    const ana = await t.signUp('ana@example.com');
    await t.prisma.userBadge.create({
      data: { userId: ana.userId, badgeId: 'first-session', earnedAt: new Date() },
    });

    const badges = (await get(auth, 'badges')) as { items: Body[] };
    expect(badges.items[0]).toEqual({
      id: 'first-session',
      category: 'focus',
      rarity: 'common',
      source: 'achievement',
      availability: 'permanent',
      availableFrom: null,
      availableUntil: null,
      status: 'active',
      name: 'First Session',
      description: 'Your first counted focus session.',
      artworkId: 'first-session',
      sortOrder: 10,
      owners: 1,
    });
    expect(((await get(auth, 'species')) as { items: Body[] }).items[0]).toMatchObject({
      id: 'signature',
      source: 'system',
      owners: 0,
    });
    expect(
      ((await get(auth, 'cosmetics')) as { items: Body[] }).items.map((i) => i['id']),
    ).toContain('meadow');
    const achievements = ((await get(auth, 'achievements')) as { items: Body[] }).items;
    expect(achievements.find((a) => a['id'] === 'first-session')).toEqual({
      id: 'first-session',
      badgeId: 'first-session',
      criterion: 'counted_sessions',
      target: 1,
      progressVisible: false,
      owners: 1,
    });
    expect(await get(auth, 'badges/first-session')).toMatchObject({
      id: 'first-session',
      owners: 1,
      usedBy: [{ type: 'achievement', id: 'first-session' }],
    });
  });

  it('creates a badge and its achievement, then the app can earn it', async () => {
    const auth = await admin('content@example.com', 'content');
    const created = (await post(auth, 'badges', BADGE).expect(201)).body as Body;
    expect(created).toMatchObject({ id: 'deep-diver', status: 'active', owners: 0 });
    await post(auth, 'achievements', {
      id: 'deep-diver',
      badgeId: 'deep-diver',
      criterion: 'counted_sessions',
      target: 20,
      progressVisible: true,
      reason: 'Earned with twenty sessions',
    }).expect(201);

    expect(
      await t.prisma.achievementDefinition.findUnique({ where: { id: 'deep-diver' } }),
    ).toMatchObject({ badgeId: 'deep-diver', target: 20 });
    expect(await audit()).toEqual([
      ['content.badge.create', 'deep-diver', 'New long-session badge', { status: 'active' }],
      ['content.achievement.create', 'deep-diver', 'Earned with twenty sessions', {}],
    ]);
  });

  it('refuses what the catalog cannot hold, saying why', async () => {
    const auth = await admin('content@example.com', 'content');
    const problems = async (kind: string, body: Body) =>
      ((await post(auth, kind, body).expect(422)).body as { problems: string[] }).problems;

    expect(await problems('badges', { ...BADGE, id: 'Deep Diver' })).toContainEqual(
      expect.stringContaining('id'),
    );
    expect(await problems('badges', { ...BADGE, name: '  ' })).toContainEqual(
      expect.stringContaining('name'),
    );
    expect(await problems('badges', { ...BADGE, availability: 'limited' })).toContainEqual(
      expect.stringContaining('availableUntil'),
    );
    expect(
      await problems('badges', {
        ...BADGE,
        availability: 'limited',
        availableFrom: '2026-12-01T00:00:00.000Z',
        availableUntil: '2026-11-01T00:00:00.000Z',
      }),
    ).toContainEqual(expect.stringContaining('availableFrom'));
    // System content is owned by everyone: only a release defines it.
    expect(await problems('badges', { ...BADGE, source: 'system' })).toContainEqual(
      expect.stringContaining('source'),
    );
    expect(await problems('badges', { ...BADGE, status: 'retired' })).toContainEqual(
      expect.stringContaining('status'),
    );
    expect(await problems('badges', { ...BADGE, colour: 'gold' })).toContainEqual(
      expect.stringContaining('colour'),
    );
    expect(await problems('badges', { ...BADGE, reason: '' })).toContainEqual(
      expect.stringContaining('reason'),
    );
    expect(
      await problems('cosmetics', {
        id: 'lantern-row',
        type: 'decoration',
        rarity: 'common',
        source: 'achievement',
        achievementId: null,
        availability: 'permanent',
        availableFrom: null,
        availableUntil: null,
        status: 'active',
        name: 'Lantern Row',
        description: 'Lanterns along the path.',
        artworkId: 'lantern-row',
        sortOrder: 60,
        reason: 'New decoration',
      }),
    ).toContainEqual(expect.stringContaining('achievementId'));
    expect(
      await problems('achievements', {
        id: 'nowhere',
        badgeId: 'missing-badge',
        criterion: 'counted_sessions',
        target: 1,
        progressVisible: true,
        reason: 'Test',
      }),
    ).toContainEqual(expect.stringContaining('missing-badge'));
    await post(auth, 'badges', BADGE).expect(201);
    expect((await post(auth, 'badges', BADGE).expect(409)).body).toMatchObject({
      code: 'content_exists',
    });
    expect(await audit()).toHaveLength(1);
  });

  it('links only to content that exists and fits', async () => {
    const auth = await admin('content@example.com', 'content');
    const problems = async (kind: string, body: Body) =>
      ((await post(auth, kind, body).expect(422)).body as { problems: string[] }).problems;
    const achievement = {
      id: 'early-bird',
      criterion: 'counted_sessions',
      target: 5,
      progressVisible: true,
      reason: 'New achievement',
    };
    // A seasonal badge is not earned by an achievement; a badge has at most one achievement.
    await post(auth, 'badges', { ...BADGE, id: 'lantern-night', source: 'season' }).expect(201);
    expect(await problems('achievements', { ...achievement, badgeId: 'lantern-night' })).toEqual([
      'badgeId: the badge lantern-night is not earned by an achievement.',
    ]);
    expect(await problems('achievements', { ...achievement, badgeId: 'first-session' })).toEqual([
      'badgeId: the badge first-session already has an achievement.',
    ]);
    expect(
      await problems('cosmetics', {
        id: 'lantern-row',
        type: 'decoration',
        rarity: 'common',
        source: 'achievement',
        achievementId: 'no-such-achievement',
        availability: 'permanent',
        availableFrom: null,
        availableUntil: null,
        status: 'active',
        name: 'Lantern Row',
        description: 'Lanterns along the path.',
        artworkId: 'lantern-row',
        sortOrder: 60,
        reason: 'New decoration',
      }),
    ).toEqual(['achievementId: there is no achievement no-such-achievement.']);
  });

  it('edits copy and windows, never the id or the source', async () => {
    const auth = await admin('content@example.com', 'content');
    await post(auth, 'badges', BADGE).expect(201);
    const edited = (
      await patch(auth, 'badges', 'deep-diver', {
        name: 'Deep Diver II',
        description: 'Twenty long sessions, steadily.',
        sortOrder: 200,
        reason: 'Clearer copy',
      }).expect(200)
    ).body as Body;
    expect(edited).toMatchObject({
      name: 'Deep Diver II',
      description: 'Twenty long sessions, steadily.',
    });
    expect(
      (
        (await patch(auth, 'badges', 'deep-diver', { id: 'deeper', reason: 'Rename' }).expect(422))
          .body as { problems: string[] }
      ).problems,
    ).toContainEqual(expect.stringContaining('id'));
    await patch(auth, 'badges', 'deep-diver', { source: 'season', reason: 'Move' }).expect(422);
    // Events were removed (owner, 2026-10-22): no new event content.
    await post(auth, 'badges', { ...BADGE, id: 'event-night', source: 'event' }).expect(422);
    await patch(auth, 'badges', 'missing', { name: 'X', reason: 'Nothing' }).expect(404);
    expect(await audit()).toEqual([
      ['content.badge.create', 'deep-diver', 'New long-session badge', { status: 'active' }],
      ['content.badge.update', 'deep-diver', 'Clearer copy', { fields: 'description,name' }],
    ]);
  });

  it('retires owned content instead of deleting it, and keeps earned terms', async () => {
    const auth = await admin('content@example.com', 'content');
    const ana = await t.signUp('ana@example.com');
    await t.prisma.userBadge.create({
      data: { userId: ana.userId, badgeId: 'focus-streak:7', earnedAt: new Date() },
    });

    expect((await remove(auth, 'badges', 'focus-streak:7').expect(409)).body).toMatchObject({
      code: 'content_in_use',
    });
    // Its achievement's terms are what people earned it with.
    expect(
      (
        (
          await patch(auth, 'achievements', 'focus-streak:7', {
            target: 8,
            reason: 'Harder',
          }).expect(422)
        ).body as { problems: string[] }
      ).problems,
    ).toContainEqual(expect.stringContaining('owned'));
    await patch(auth, 'achievements', 'focus-streak:7', {
      progressVisible: false,
      reason: 'Hide the count',
    }).expect(200);

    await patch(auth, 'badges', 'focus-streak:7', {
      status: 'retired',
      reason: 'Season over',
    }).expect(200);
    // Owned content cannot go back to planned.
    await patch(auth, 'badges', 'focus-streak:7', { status: 'planned', reason: 'Oops' }).expect(
      422,
    );
    await patch(auth, 'badges', 'focus-streak:7', { status: 'active', reason: 'Back' }).expect(200);
    expect(await t.prisma.userBadge.count()).toBe(1);
    expect((await audit()).map((row) => row[0])).toEqual([
      'content.achievement.update',
      'content.badge.update',
      'content.badge.update',
    ]);
    expect((await audit())[1]![3]).toEqual({ fields: 'status', from: 'active', to: 'retired' });
  });

  it('deletes content nobody owns or uses', async () => {
    const auth = await admin('content@example.com', 'content');
    await post(auth, 'badges', { ...BADGE, status: 'planned' }).expect(201);
    await remove(auth, 'badges', 'deep-diver').expect(204);
    expect(await t.prisma.badgeDefinition.findUnique({ where: { id: 'deep-diver' } })).toBeNull();
    expect((await audit()).at(-1)).toEqual([
      'content.badge.delete',
      'deep-diver',
      'Created by mistake',
      {},
    ]);
    // A badge an achievement uses stays.
    await remove(auth, 'badges', 'focus-hours:500').expect(409);
  });

  it('keeps system content as it is', async () => {
    const auth = await admin('content@example.com', 'content');
    await patch(auth, 'species', 'signature', { status: 'retired', reason: 'Try' }).expect(422);
    await remove(auth, 'cosmetics', 'meadow').expect(409);
    await patch(auth, 'cosmetics', 'meadow', {
      description: 'Rolling hills.',
      reason: 'Copy',
    }).expect(200);
  });

  it('creates species variants and cosmetics earned by achievements', async () => {
    const auth = await admin('content@example.com', 'content');
    await post(auth, 'species', {
      id: 'silver-oak',
      baseSpeciesId: 'oak',
      rarity: 'rare',
      source: 'achievement',
      achievementId: 'focus-hours:100',
      availability: 'permanent',
      availableFrom: null,
      availableUntil: null,
      status: 'planned',
      name: 'Silver Oak',
      description: 'An oak with silver leaves.',
      sortOrder: 95,
      reason: 'New variant',
    }).expect(201);
    await post(auth, 'species', {
      id: 'ghost-oak',
      baseSpeciesId: 'nowhere',
      rarity: 'rare',
      source: 'season',
      achievementId: null,
      availability: 'permanent',
      availableFrom: null,
      availableUntil: null,
      status: 'planned',
      name: 'Ghost Oak',
      description: 'A pale oak.',
      sortOrder: 96,
      reason: 'New variant',
    }).expect(422);
    await post(auth, 'cosmetics', {
      id: 'lantern-row',
      type: 'decoration',
      rarity: 'common',
      source: 'season',
      achievementId: null,
      availability: 'limited',
      availableFrom: '2026-11-01T00:00:00.000Z',
      availableUntil: '2026-12-01T00:00:00.000Z',
      status: 'active',
      name: 'Lantern Row',
      description: 'Lanterns along the path.',
      artworkId: 'lantern-row',
      sortOrder: 60,
      reason: 'Seasonal decoration',
    }).expect(201);
    expect(await get(auth, 'cosmetics/lantern-row')).toMatchObject({
      availableUntil: '2026-12-01T00:00:00.000Z',
      usedBy: [],
    });
  });

  it('lets only admins and content staff manage content', async () => {
    for (const role of ['support', 'moderator'] as const) {
      const auth = await admin(`${role}@example.com`, role);
      await t.http().get('/admin/content/badges').set(auth).expect(403);
      await post(auth, 'badges', BADGE).expect(403);
    }
    const boss = await admin('admin@example.com', 'admin');
    await post(boss, 'badges', BADGE).expect(201);
    await t.http().get('/admin/content/nothing').set(boss).expect(404);
  });

  it('gives content staff no access to users or configuration', async () => {
    const auth = await admin('content@example.com', 'content');
    await t.http().get('/admin/users').set(auth).expect(403);
    await t.http().get('/admin/reports').set(auth).expect(403);
    await t.http().get('/admin/audit-log').set(auth).expect(403);
    await t.http().get('/admin/dashboard').set(auth).expect(200);
    expect((await t.http().get('/admin/auth/me').set(auth).expect(200)).body).toMatchObject({
      role: 'content',
    });
  });
});
