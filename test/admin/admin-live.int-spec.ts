import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A6.5 admin live operations (docs/09 later admin: events and missions, Community Tree,
 * seasonal content, leaderboards). Events and seasons are created and edited without a deploy,
 * under the same checks as content packs; what people already took part in is locked; the
 * Community Tree is monitored; abusive accounts are kept off every board. All audited.
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

/** Event badges, acquirable through the event and a week after. */
async function badges() {
  for (const id of ['winter-sprint:steady', 'winter-sprint:seedling', 'season:winter-test']) {
    await t.prisma.badgeDefinition.create({
      data: {
        id,
        category: 'event',
        rarity: 'common',
        source: id.startsWith('season') ? 'season' : 'event',
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

const EVENT = {
  id: 'winter-sprint',
  name: 'Winter Sprint',
  description: 'Two weeks of winter focus.',
  artworkId: 'winter-sprint',
  status: 'active',
  startsAt: '2026-11-10T00:00:00.000Z',
  endsAt: '2026-11-24T00:00:00.000Z',
  entryMinSessions: 0,
  leaderboard: true,
  teams: [
    { id: 'pine', name: 'Pine' },
    { id: 'birch', name: 'Birch' },
  ],
  missions: [
    {
      id: 'two-hours',
      measure: 'focus_minutes',
      target: 120,
      dailyMinutes: 0,
      name: 'Focus 2 hours',
      description: 'Two hours of focus.',
    },
    {
      id: 'five-days',
      measure: 'active_days',
      target: 5,
      dailyMinutes: 15,
      name: 'Focus on 5 days',
      description: 'Fifteen minutes on five days.',
    },
  ],
  milestones: [
    {
      id: 'steady',
      name: 'Steady',
      requiredMissions: 2,
      badgeId: 'winter-sprint:steady',
      trait: true,
    },
  ],
  communityTree: {
    name: 'The Winter Pine',
    artworkId: 'winter-pine',
    milestones: [{ stage: 'seedling', thresholdMinutes: 60, badgeId: 'winter-sprint:seedling' }],
  },
  reason: 'Winter event',
};

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

  describe('events', () => {
    it('creates an event the app serves, with its missions, teams, and Community Tree', async () => {
      const auth = await admin('content@example.com', 'content');
      const created = (await post(auth, 'events', EVENT).expect(201)).body as Body;
      expect(created).toMatchObject({
        id: 'winter-sprint',
        status: 'active',
        participants: 0,
        locked: false,
        missions: [{ id: 'two-hours' }, { id: 'five-days' }],
        milestones: [{ id: 'steady', traitId: 'event:winter-sprint' }],
        teams: [{ id: 'pine' }, { id: 'birch' }],
        communityTree: { name: 'The Winter Pine', totalMinutes: 0, contributors: 0 },
      });

      const ana = await t.signUp('ana@example.com');
      const events = (await t.http().get('/events').set(ana.auth).expect(200)).body as {
        items: Body[];
      };
      expect(events.items.map((e) => [e['id'], e['phase']])).toEqual([
        ['winter-sprint', 'upcoming'],
      ]);
      expect(await audit()).toEqual([['content.event.create', 'winter-sprint', 'Winter event']]);
    });

    it('refuses an event the content checks refuse, saying why', async () => {
      const auth = await admin('content@example.com', 'content');
      expect(
        problems(
          await post(auth, 'events', { ...EVENT, endsAt: '2026-11-09T00:00:00.000Z' }).expect(422),
        ),
      ).toContainEqual(expect.stringContaining('ends before it starts'));
      expect(
        problems(
          await post(auth, 'events', {
            ...EVENT,
            milestones: [{ ...EVENT.milestones[0], badgeId: 'season:winter-test' }],
          }).expect(422),
        ),
      ).toContainEqual(expect.stringContaining('season:winter-test'));
      expect(
        problems(
          await post(auth, 'events', {
            ...EVENT,
            milestones: [{ ...EVENT.milestones[0], badgeId: 'no-such-badge' }],
          }).expect(422),
        ),
      ).toContainEqual(expect.stringContaining('no-such-badge'));
      expect(
        problems(await post(auth, 'events', { ...EVENT, leaderboard: false }).expect(422)),
      ).toContainEqual(expect.stringContaining('pine'));
      // New rewards are badges: a cosmetic is not one, even an event cosmetic.
      await t.prisma.cosmeticDefinition.create({
        data: {
          id: 'snow-lantern',
          type: 'decoration',
          rarity: 'common',
          source: 'event',
          availability: 'limited',
          status: 'active',
          availableFrom: new Date('2026-11-01T00:00:00Z'),
          availableUntil: new Date('2027-04-01T00:00:00Z'),
          name: 'Snow Lantern',
          description: 'A lantern in the snow.',
          artworkId: 'snow-lantern',
        },
      });
      expect(
        problems(
          await post(auth, 'events', {
            ...EVENT,
            milestones: [{ ...EVENT.milestones[0], badgeId: 'snow-lantern' }],
          }).expect(422),
        ),
      ).toContainEqual(expect.stringContaining('snow-lantern'));
      expect(
        problems(
          await post(auth, 'events', {
            ...EVENT,
            milestones: [{ ...EVENT.milestones[0], badgeId: 'meadow' }],
          }).expect(422),
        ),
      ).toContainEqual(expect.stringContaining('meadow'));
      await post(auth, 'events', EVENT).expect(201);
      expect((await post(auth, 'events', EVENT).expect(409)).body).toMatchObject({
        code: 'content_exists',
      });
    });

    it('edits everything until someone joins, then locks what they took part in', async () => {
      let auth = await admin('content@example.com', 'content');
      await post(auth, 'events', EVENT).expect(201);
      await patch(auth, 'events/winter-sprint', {
        missions: [EVENT.missions[0]],
        milestones: [{ ...EVENT.milestones[0], requiredMissions: 1 }],
        reason: 'Simpler',
      }).expect(200);

      await t.setNow('2026-11-11T10:00:00.000Z');

      auth = await signIn('content@example.com');
      const ana = await t.signUp('ana@example.com');
      await t.http().post('/events/winter-sprint/join').set(ana.auth).expect(200);

      const locked = await get(auth, 'events/winter-sprint');
      expect(locked).toMatchObject({ participants: 1, locked: true });
      expect(
        problems(
          await patch(auth, 'events/winter-sprint', {
            missions: EVENT.missions,
            reason: 'More',
          }).expect(422),
        ),
      ).toContainEqual(expect.stringContaining('missions'));
      expect(
        problems(
          await patch(auth, 'events/winter-sprint', {
            startsAt: '2026-11-12T00:00:00.000Z',
            reason: 'Later',
          }).expect(422),
        ),
      ).toContainEqual(expect.stringContaining('startsAt'));
      // An earlier end would take time away from people taking part.
      await patch(auth, 'events/winter-sprint', {
        endsAt: '2026-11-20T00:00:00.000Z',
        reason: 'Shorter',
      }).expect(422);
      await patch(auth, 'events/winter-sprint', {
        name: 'Winter Sprint 2026',
        endsAt: '2026-11-26T00:00:00.000Z',
        reason: 'A little longer',
      }).expect(200);
      await patch(auth, 'events/winter-sprint', { status: 'retired', reason: 'Over' }).expect(200);
      expect(
        await t.prisma.event.findUniqueOrThrow({ where: { id: 'winter-sprint' } }),
      ).toMatchObject({
        name: 'Winter Sprint 2026',
        status: 'retired',
        endsAt: new Date('2026-11-26T00:00:00Z'),
      });
      // Taking part keeps the event: it cannot be deleted.
      await t
        .http()
        .delete('/admin/live/events/winter-sprint')
        .set(auth)
        .send({ reason: 'Remove' })
        .expect(409);
    });

    it('monitors the Community Tree', async () => {
      let auth = await admin('content@example.com', 'content');
      await post(auth, 'events', { ...EVENT, startsAt: '2026-11-01T00:00:00.000Z' }).expect(201);
      const ana = await t.signUp('ana@example.com');
      await t.http().post('/events/winter-sprint/join').set(ana.auth).expect(200);
      await t.submit(ana, '2026-11-02T09:00:00.000Z', 45).expect(201);
      await t.setNow('2026-11-02T11:00:00.000Z');
      auth = await signIn('content@example.com');
      await t.submit(ana, '2026-11-02T10:00:00.000Z', 30).expect(201);

      expect((await get(auth, 'events/winter-sprint')).communityTree).toEqual({
        name: 'The Winter Pine',
        artworkId: 'winter-pine',
        totalMinutes: 75,
        contributors: 1,
        milestones: [
          {
            stage: 'seedling',
            thresholdMinutes: 60,
            badgeId: 'winter-sprint:seedling',
            reachedAt: '2026-11-02T11:00:00.000Z',
          },
        ],
      });
    });

    it('deletes an event nobody joined', async () => {
      const auth = await admin('content@example.com', 'content');
      await post(auth, 'events', EVENT).expect(201);
      await t
        .http()
        .delete('/admin/live/events/winter-sprint')
        .set(auth)
        .send({ reason: 'Created by mistake' })
        .expect(204);
      expect(await t.prisma.event.count()).toBe(0);
      expect((await audit()).at(-1)).toEqual([
        'content.event.delete',
        'winter-sprint',
        'Created by mistake',
      ]);
    });
  });

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
            rewards: [{ id: 'a', badgeId: 'winter-sprint:steady', requiredActiveDays: 5 }],
          }).expect(422),
        ),
      ).toContainEqual(expect.stringContaining('winter-sprint:steady'));
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
      // An event without a board has none to show.
      await t.prisma.event.create({
        data: {
          id: 'quiet',
          name: 'Quiet',
          description: 'No board.',
          artworkId: 'quiet',
          status: 'active',
          startsAt: new Date('2026-11-01T00:00:00Z'),
          endsAt: new Date('2026-11-10T00:00:00Z'),
        },
      });
      await t
        .http()
        .get('/admin/live/leaderboards?scope=event&eventId=quiet')
        .set(auth)
        .expect(404);
      expect((await audit()).map((row) => row[0])).toEqual([
        'leaderboard.exclude',
        'leaderboard.include',
      ]);
    });
  });

  it('lets only admins and content staff run live content', async () => {
    for (const role of ['support', 'moderator'] as const) {
      const auth = await admin(`${role}@example.com`, role);
      await t.http().get('/admin/live/events').set(auth).expect(403);
      await post(auth, 'themes', THEME).expect(403);
    }
  });
});
