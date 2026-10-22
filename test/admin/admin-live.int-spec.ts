import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A6.5 admin live operations (docs/09 later admin: seasonal content, leaderboards). Seasons are
 * created and edited without a deploy, under the same checks as content packs; what people
 * already took part in is locked; abusive accounts are kept off every board. All audited.
 * Events and the Community Tree were removed (owner, 2026-10-22).
 */

const t = new ConsistencyHarness('2026-11-02T10:00:00.000Z');
const PASSWORD = 'correct horse battery staple admin';
const hasher = new PasswordHasher({ cost: 2 ** 10 });
type Auth = Record<string, string>;
type Body = Record<string, unknown>;
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

async function admin(email: string, role: 'admin' | 'support' | 'moderator' | 'content') {
  await createAdmin(t.prisma, hasher, { email, role, password: PASSWORD });
  return signIn(email);
}
/** Admin tokens are short-lived: sign in again after moving the clock. */
async function signIn(email: string) {
  const res = await t.http().post('/admin/auth/sign-in').send({ email, password: PASSWORD });
  return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
}
const audit = async () =>
  (await t.prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'asc' } }))
    .filter((row) => row.action !== 'admin.sign_in')
    .map((row) => [row.action, row.targetId, row.reason]);

/** A seasonal badge, acquirable through the theme and after. */
async function badges() {
  for (const id of ['season:winter-test']) {
    await t.prisma.badgeDefinition.create({
      data: {
        id,
        category: 'event',
        rarity: 'common',
        source: 'season',
        availability: 'limited',
        status: 'active',
        availableFrom: new Date('2026-11-01T00:00:00Z'),
        availableUntil: new Date('2027-04-01T00:00:00Z'),
        name: id,
        description: `The ${id} badge.`,
        artworkId: id.replace(':', '-'),
      },
    });
  }
}

const THEME = {
  id: 'winter-test-north',
  name: 'Winter',
  description: 'Snow settles softly.',
  environmentId: 'winter',
  hemisphere: 'north',
  status: 'active',
  startsAt: '2026-12-01T00:00:00.000Z',
  endsAt: '2027-03-01T00:00:00.000Z',
  rewards: [{ id: 'ten-days', badgeId: 'season:winter-test', requiredActiveDays: 10 }],
  reason: 'Winter theme',
};

describe('admin live operations (A6.5)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.activateConfig();
    await t.setNow('2026-11-02T10:00:00.000Z');
    await badges();
  });

  const post = (auth: Auth, path: string, body: Body) =>
    t.http().post(`/admin/live/${path}`).set(auth).send(body);
  const patch = (auth: Auth, path: string, body: Body) =>
    t.http().patch(`/admin/live/${path}`).set(auth).send(body);
  const get = async (auth: Auth, path: string) =>
    (await t.http().get(`/admin/live/${path}`).set(auth).expect(200)).body as Body;
  const problems = (res: { body: unknown }) => (res.body as { problems: string[] }).problems;

  describe('seasonal themes', () => {
    it('schedules a theme the app serves to its hemisphere', async () => {
      let auth = await admin('content@example.com', 'content');
      await post(auth, 'themes', THEME).expect(201);
      const bea = await t.signUp('bea@example.com', 'Europe/Berlin');
      await t.setNow('2026-12-05T10:00:00.000Z');
      auth = await signIn('content@example.com');
      expect((await t.http().get('/me/season').set(bea.auth).expect(200)).body).toMatchObject({
        theme: { id: 'winter-test-north', environmentId: 'winter' },
        rewards: [{ requiredActiveDays: 10 }],
      });
      expect(((await get(auth, 'themes')) as { items: Body[] }).items).toEqual([
        expect.objectContaining({ id: 'winter-test-north', hemisphere: 'north', started: true }),
      ]);
    });

    it('refuses overlapping themes, unknown art, and non-season badges', async () => {
      const auth = await admin('content@example.com', 'content');
      await post(auth, 'themes', THEME).expect(201);
      expect(
        problems(
          await post(auth, 'themes', {
            ...THEME,
            id: 'snow-north',
            startsAt: '2027-02-01T00:00:00.000Z',
            endsAt: '2027-04-01T00:00:00.000Z',
            rewards: [],
          }).expect(422),
        ),
      ).toContainEqual(expect.stringContaining('winter-test-north'));
      // The other hemisphere may hold its own theme at the same time.
      await post(auth, 'themes', {
        ...THEME,
        id: 'summer-test-south',
        hemisphere: 'south',
        environmentId: 'summer',
        rewards: [],
      }).expect(201);
      expect(
        problems(
          await post(auth, 'themes', {
            ...THEME,
            id: 'fireworks',
            environmentId: 'fireworks',
            hemisphere: null,
            startsAt: '2027-06-01T00:00:00.000Z',
            endsAt: '2027-07-01T00:00:00.000Z',
            rewards: [],
          }).expect(422),
        ),
      ).toContainEqual(expect.stringContaining('fireworks'));
      expect(
        problems(
          await post(auth, 'themes', {
            ...THEME,
            id: 'spring-test-north',
            startsAt: '2027-03-01T00:00:00.000Z',
            endsAt: '2027-03-20T00:00:00.000Z',
            rewards: [{ id: 'a', badgeId: 'early-bird', requiredActiveDays: 5 }],
          }).expect(422),
        ),
      ).toContainEqual(expect.stringContaining('early-bird'));
    });

    it('lets a retired theme make room, and deletes only a theme not yet started', async () => {
      const auth = await admin('content@example.com', 'content');
      await post(auth, 'themes', THEME).expect(201);
      await patch(auth, 'themes/winter-test-north', {
        status: 'retired',
        reason: 'Replaced',
      }).expect(200);
      await post(auth, 'themes', { ...THEME, id: 'snow-north', rewards: [] }).expect(201);
      await t
        .http()
        .delete('/admin/live/themes/winter-test-north')
        .set(auth)
        .send({ reason: 'Not needed' })
        .expect(204);
      await t.setNow('2026-12-05T10:00:00.000Z');
      const later = await signIn('content@example.com');
      await t
        .http()
        .delete('/admin/live/themes/snow-north')
        .set(later)
        .send({ reason: 'Not needed' })
        .expect(409);
    });

    it('locks a started theme’s start, hemisphere, and rewards', async () => {
      let auth = await admin('content@example.com', 'content');
      await post(auth, 'themes', THEME).expect(201);
      await t.setNow('2026-12-05T10:00:00.000Z');
      auth = await signIn('content@example.com');
      for (const change of [
        { startsAt: '2026-12-02T00:00:00.000Z' },
        { hemisphere: 'south' },
        { rewards: [] },
      ]) {
        await patch(auth, 'themes/winter-test-north', { ...change, reason: 'Change' }).expect(422);
      }
      await patch(auth, 'themes/winter-test-north', {
        description: 'Snow, and the quiet after it.',
        environmentId: 'night',
        reason: 'Calmer art',
      }).expect(200);
    });
  });

  describe('leaderboards', () => {
    async function boardUser(email: string, minutes: number): Promise<User> {
      const user = await t.signUp(email);
      await t.http().patch('/me/privacy').set(user.auth).send({ leaderboards: true }).expect(200);
      await t.focus(user, [['2026-11-02', minutes]]);
      return user;
    }

    it('shows any board and keeps excluded accounts off every board', async () => {
      const auth = await admin('content@example.com', 'content');
      const ana = await boardUser('ana@example.com', 60);
      const ben = await boardUser('ben@example.com', 30);
      const view = async () =>
        ((await get(auth, 'leaderboards?scope=global&period=weekly')) as { rows: Body[] }).rows.map(
          (row) => (row['person'] as Body)['id'],
        );
      expect(await view()).toEqual([ana.userId, ben.userId]);

      await post(auth, 'leaderboard-exclusions', {
        userId: ana.userId,
        reason: 'Manipulated sessions',
      }).expect(201);
      expect(await view()).toEqual([ben.userId]);
      expect(
        (
          await post(auth, 'leaderboard-exclusions', {
            userId: ana.userId,
            reason: 'Again',
          }).expect(409)
        ).body,
      ).toMatchObject({ code: 'already_excluded' });
      const asBen = (
        await t.http().get('/leaderboards?scope=global&period=weekly').set(ben.auth).expect(200)
      ).body as { rows: Body[] };
      expect(asBen.rows.map((row) => (row['person'] as Body)['id'])).toEqual([ben.userId]);
      expect(((await get(auth, 'leaderboard-exclusions')) as { items: Body[] }).items).toEqual([
        expect.objectContaining({
          user: expect.objectContaining({ id: ana.userId }) as Body,
          reason: 'Manipulated sessions',
        }),
      ]);

      await t
        .http()
        .delete(`/admin/live/leaderboard-exclusions/${ana.userId}`)
        .set(auth)
        .send({ reason: 'Cleared after review' })
        .expect(204);
      expect(await view()).toEqual([ana.userId, ben.userId]);
      await t
        .http()
        .delete(`/admin/live/leaderboard-exclusions/${ana.userId}`)
        .set(auth)
        .send({ reason: 'Twice' })
        .expect(404);
      // There are no event boards any more (owner, 2026-10-22).
      await t
        .http()
        .get('/admin/live/leaderboards?scope=event&eventId=quiet')
        .set(auth)
        .expect(400);
      await t.http().get('/admin/live/events').set(auth).expect(404);
      expect((await audit()).map((row) => row[0])).toEqual([
        'leaderboard.exclude',
        'leaderboard.include',
      ]);
    });
  });

  it('lets only admins and content staff run live content', async () => {
    for (const role of ['support', 'moderator'] as const) {
      const auth = await admin(`${role}@example.com`, role);
      await t.http().get('/admin/live/themes').set(auth).expect(403);
      await post(auth, 'themes', THEME).expect(403);
    }
  });
});
