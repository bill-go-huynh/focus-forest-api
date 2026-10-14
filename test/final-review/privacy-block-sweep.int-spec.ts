import type { Response } from 'supertest';

import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * Final review FR.5: privacy and blocks on every route that reaches another person
 * (HTTP + PostgreSQL). Spec §19.1–19.2, docs/06 Block ("overrides everything"), docs/12 Phase 11
 * ("every cross-user read respects per-category privacy; blocking is immediate and complete").
 *
 * Each route is already tested in its own module. This sweep checks them all the same way, and
 * a guard fails when a new route that reaches another person is added without being listed here.
 *
 * Ana, Ben, and Cyd are friends (mutual follows), focus this week, and appear on boards. Then Ana
 * blocks Ben. Every read must hide the other person in both directions, while the same read still
 * shows Cyd (so a hidden answer is the block, not an empty route). Every action toward the other
 * person must be refused in both directions, while the same action toward Cyd works.
 */

const t = new ConsistencyHarness('2026-10-14T12:00:00.000Z');
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>> & { name: string };
type Call = (viewer: User, other: User) => Promise<Response>;

const ALL_PRIVATE = {
  profile: 'private',
  forest: 'private',
  statistics: 'private',
  badges: 'private',
  currentTree: 'private',
};

describe('final review FR.5: privacy and blocks on every cross-user route (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-14T12:00:00.000Z');
    await t.activateConfig();
  });

  const http = () => t.http();

  async function person(name: string): Promise<User> {
    const user = await t.signUp(`${name}@example.com`, 'UTC', '2026-09-01T00:00:00.000Z');
    await http().patch('/me/profile').set(user.auth).send({ username: name }).expect(200);
    await http().patch('/me/privacy').set(user.auth).send({ leaderboards: true }).expect(200);
    await t.submit(user, '2026-10-14T08:00:00.000Z', 30).expect(201);
    return { ...user, name };
  }
  const befriend = async (a: User, b: User) => {
    await http().put(`/me/following/${b.userId}`).set(a.auth).expect(200);
    await http().put(`/me/following/${a.userId}`).set(b.auth).expect(200);
  };

  /** Reads that show another person: the answer must not mention them once blocked. */
  const READS: Record<string, Call> = {
    'GET /users/:userId': (v, o) => http().get(`/users/${o.userId}`).set(v.auth),
    'GET /users/:userId/profile': (v, o) => http().get(`/users/${o.userId}/profile`).set(v.auth),
    'GET /users/:userId/forest': (v, o) => http().get(`/users/${o.userId}/forest`).set(v.auth),
    'GET /users/:userId/forest/:year/:month': (v, o) =>
      http().get(`/users/${o.userId}/forest/2026/10`).set(v.auth),
    'GET /users/:userId/reactions': (v, o) =>
      http().get(`/users/${o.userId}/reactions`).query({ target: 'tree:2026-10' }).set(v.auth),
    'GET /users/search': (v, o) => http().get('/users/search').query({ q: o.name }).set(v.auth),
    'GET /me/following': (v) => http().get('/me/following').set(v.auth),
    'GET /me/followers': (v) => http().get('/me/followers').set(v.auth),
    'GET /me/reactions': (v) => http().get('/me/reactions').set(v.auth),
    'GET /leaderboards (friends)': (v) => http().get('/leaderboards').set(v.auth),
    'GET /leaderboards (global)': (v) => http().get('/leaderboards?scope=global').set(v.auth),
  };

  /** Actions toward another person: refused once blocked. */
  const ACTIONS: Record<string, Call> = {
    'PUT /me/following/:userId': (v, o) => http().put(`/me/following/${o.userId}`).set(v.auth),
    'PUT /users/:userId/reactions/:reaction': (v, o) =>
      http()
        .put(`/users/${o.userId}/reactions/sparkles`)
        .query({ target: 'tree:2026-10' })
        .set(v.auth),
    'POST /me/challenges (invite)': (v, o) =>
      http()
        .post('/me/challenges')
        .set(v.auth)
        .send({ templateId: 'ten-hours-each', invite: [o.userId] }),
    'POST /rooms/:id/invites': async (v, o) => {
      const room = await http()
        .post('/rooms')
        .set(v.auth)
        .send({ name: 'Study', durationMinutes: 25, maxParticipants: 4, visibility: 'private' });
      const id = (room.body as { id?: string }).id ?? (await currentRoom(v));
      return http()
        .post(`/rooms/${id}/invites`)
        .set(v.auth)
        .send({ userIds: [o.userId] });
    },
  };
  const currentRoom = async (user: User) =>
    (
      (await http().get('/rooms/current').set(user.auth).expect(200)).body as {
        room: { id: string };
      }
    ).room.id;

  /**
   * Routes that reach another person but need no check here: they only end a relationship, or
   * they are about a room or challenge the caller is already in (checked in their modules).
   */
  const EXEMPT: Record<string, string> = {
    'DELETE /me/following/:userId': 'ends a follow',
    'DELETE /me/followers/:userId': 'ends a follow',
    'PUT /me/blocks/:userId': 'the block itself',
    'DELETE /me/blocks/:userId': 'the unblock itself',
    'DELETE /users/:userId/reactions/:reaction': 'removes one’s own reaction',
  };

  /** These answers are about one person and name no one: answering at all shows them. */
  const STATUS_ONLY = new Set([
    'GET /users/:userId/reactions',
    'GET /users/:userId/forest',
    'GET /users/:userId/forest/:year/:month',
  ]);
  let current = '';
  const mentions = (res: Response, other: User) =>
    res.status < 300 &&
    (STATUS_ONLY.has(current) || JSON.stringify(res.body).includes(other.userId));

  it('lists every route that reaches another person', () => {
    const instance = t.app.getHttpAdapter().getInstance() as Record<string, unknown>;
    const router = (instance['router'] ?? instance['_router']) as {
      stack: { route?: { path: string; methods: Record<string, boolean> } }[];
    };
    const reaching = router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.keys(layer.route!.methods).map((m) => `${m.toUpperCase()} ${layer.route!.path}`),
      )
      // Staff routes have their own role checks (test/admin) and are not a person's view.
      .filter((route) => !route.includes(' /admin/'))
      .filter((route) => route.includes(':userId') || / \/users\b/.test(route));
    const known = new Set(
      [...Object.keys(READS), ...Object.keys(ACTIONS), ...Object.keys(EXEMPT)].map((key) =>
        key.replace(/ \(.*\)$/, ''),
      ),
    );
    expect(reaching.filter((route) => !known.has(route))).toEqual([]);
  });

  it('hides each person from the other on every read, and refuses every action, both ways', async () => {
    const ana = await person('ana');
    const ben = await person('ben');
    const cyd = await person('cyd');
    await befriend(ana, ben);
    await befriend(ana, cyd);
    await befriend(ben, cyd);
    await http()
      .put(`/users/${ana.userId}/reactions/fire`)
      .query({ target: 'tree:2026-10' })
      .set(ben.auth)
      .expect(200);
    await http()
      .put(`/users/${ben.userId}/reactions/fire`)
      .query({ target: 'tree:2026-10' })
      .set(ana.auth)
      .expect(200);
    await http()
      .put(`/users/${cyd.userId}/reactions/fire`)
      .query({ target: 'tree:2026-10' })
      .set(ben.auth)
      .expect(200);

    // Before the block, every read shows the other person (so the sweep is not vacuous). The
    // received-reactions list is the owner's: Ana sees Ben's reaction there.
    for (const [name, read] of Object.entries(READS)) {
      current = name;
      const [viewer, other] = name === 'GET /me/reactions' ? [ana, ben] : [ben, ana];
      expect(mentions(await read(viewer, other), other), `${name} before the block`).toBe(true);
    }

    await http().put(`/me/blocks/${ben.userId}`).set(ana.auth).expect(204);

    for (const [name, read] of Object.entries(READS)) {
      current = name;
      expect(mentions(await read(ben, ana), ana), `${name}: Ben still sees Ana`).toBe(false);
      expect(mentions(await read(ana, ben), ben), `${name}: Ana still sees Ben`).toBe(false);
    }
    // The same reads still show Cyd to Ben (the received list: Cyd sees Ben's reaction).
    for (const [name, read] of Object.entries(READS)) {
      current = name;
      const [viewer, other] = name === 'GET /me/reactions' ? [cyd, ben] : [ben, cyd];
      expect(mentions(await read(viewer, other), other), `${name}: control`).toBe(true);
    }

    for (const [name, act] of Object.entries(ACTIONS)) {
      expect((await act(ben, ana)).status, `${name}: Ben toward Ana`).toBeGreaterThanOrEqual(400);
      // Ana's own room or challenge may exist from the previous call; leave it first.
      expect((await act(ana, ben)).status, `${name}: Ana toward Ben`).toBeGreaterThanOrEqual(400);
    }
    // Ben may still do each of them toward Cyd. A room is one per person: leave the first.
    const room = await http().get('/rooms/current').set(ben.auth);
    const benRoom = (room.body as { room: { id: string } | null }).room;
    if (benRoom) await http().post(`/rooms/${benRoom.id}/leave`).set(ben.auth);
    for (const [name, act] of Object.entries(ACTIONS)) {
      expect((await act(ben, cyd)).status, `${name}: control`).toBeLessThan(300);
    }
  });

  it('shows nothing private to a friend: no tree, forest, statistics, or badges', async () => {
    const ana = await person('ana');
    const ben = await person('ben');
    await befriend(ana, ben);
    await http().patch('/me/privacy').set(ana.auth).send(ALL_PRIVATE).expect(200);

    const profile = (await http().get(`/users/${ana.userId}/profile`).set(ben.auth).expect(200))
      .body as Record<string, unknown>;
    expect(profile).toMatchObject({
      currentTree: null,
      forest: null,
      statistics: null,
      badges: null,
    });
    expect((await READS['GET /users/:userId/forest']!(ben, ana)).status).toBeGreaterThanOrEqual(
      400,
    );
    expect(
      (await READS['GET /users/:userId/forest/:year/:month']!(ben, ana)).status,
    ).toBeGreaterThanOrEqual(400);
    // Reacting to hidden content is refused too.
    expect(
      (await ACTIONS['PUT /users/:userId/reactions/:reaction']!(ben, ana)).status,
    ).toBeGreaterThanOrEqual(400);
  });
});
