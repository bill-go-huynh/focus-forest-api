import { createAdmin } from '../../src/admin/create-admin.js';
import { addDays, type LocalDate } from '../../src/common/local-date.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A7.5 Performance (docs/12 Phase 20: performance targets; Phase 7 owner decision 7): the social
 * and live reads of Phases 5–6 send the same number of SQL statements whether the viewer's world
 * holds 3 people or 30, so a read that queries once per person, room, or participant (N+1) fails.
 * Numbers are printed for the report; Phase 3's reads are pinned by X3's performance test. The
 * events list builds each active event in turn: it grows with events (a few, scheduled by staff),
 * which both worlds share, not with people.
 */

const t = new ConsistencyHarness('2026-11-06T12:00:00.000Z', { countQueries: true });
const PASSWORD = 'correct horse battery staple admin';
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

/** A week of focus, one session a day. */
const week = (from: LocalDate): [LocalDate, number][] =>
  Array.from({ length: 5 }, (_, i) => [addDays(from, i), 30 + i]);

describe('A7.5 social and live reads (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-11-06T12:00:00.000Z');
    await t.activateConfig();
  });

  async function event(id: string) {
    await t.prisma.event.create({
      data: {
        id,
        name: id,
        description: 'A month of focus.',
        artworkId: id,
        status: 'active',
        startsAt: new Date('2026-11-01T00:00:00Z'),
        endsAt: new Date('2026-11-30T00:00:00Z'),
        leaderboard: true,
        missions: {
          create: [
            {
              id: 'hours',
              measure: 'focus_minutes',
              target: 600,
              name: 'Hours',
              description: 'x',
              sortOrder: 1,
            },
          ],
        },
        communityTree: { create: { name: 'Oak', artworkId: 'oak' } },
      },
    });
  }

  /** The viewer and `others` friends: on the boards, in the event, focusing, some in lobbies. */
  async function world(tag: string, others: number) {
    const id = `world-${tag}`;
    const person = async (name: string): Promise<User> => {
      const user = await t.signUp(`${name}@example.com`, 'UTC', '2026-09-01T00:00:00.000Z');
      await t.http().patch('/me/profile').set(user.auth).send({ username: name }).expect(200);
      await t.http().patch('/me/privacy').set(user.auth).send({ leaderboards: true }).expect(200);
      await t.http().post(`/events/${id}/join`).set(user.auth).expect(200);
      await t.focus(user, week('2026-11-02'));
      return user;
    };
    const viewer = await person(`${tag}viewer`);
    const people: User[] = [];
    for (let i = 0; i < others; i += 1) {
      const friend = await person(`${tag}p${i}`);
      await t.http().put(`/me/following/${friend.userId}`).set(viewer.auth).expect(200);
      await t.http().put(`/me/following/${viewer.userId}`).set(friend.auth).expect(200);
      if (i % 3 === 0) {
        await t
          .http()
          .post('/rooms')
          .set(friend.auth)
          .send({
            name: `Room ${i}`,
            durationMinutes: 25,
            maxParticipants: 4,
            visibility: 'public',
          })
          .expect(201);
      }
      people.push(friend);
    }
    await t
      .http()
      .post('/me/challenges')
      .set(viewer.auth)
      .send({
        templateId: 'steady-week-together',
        invite: people.slice(0, Math.min(3, people.length)).map((p) => p.userId),
      })
      .expect(201);
    return { id, viewer, friend: people[0]! };
  }

  const endpoints = (w: Awaited<ReturnType<typeof world>>) => [
    '/leaderboards?scope=friends&period=weekly',
    '/leaderboards?scope=global&period=weekly',
    `/leaderboards?scope=event&eventId=${w.id}`,
    '/events',
    `/events/${w.id}`,
    `/events/${w.id}/community-tree`,
    '/rooms',
    '/me/following',
    '/me/followers',
    '/users/search?q=p',
    `/users/${w.friend.userId}/profile`,
    `/users/${w.friend.userId}/forest`,
    '/me/challenges',
    '/me/room-invites',
    '/me/collection',
    '/me/season',
    '/me/home',
  ];

  async function measure(w: Awaited<ReturnType<typeof world>>, admin: Record<string, string>) {
    const counts: Record<string, number> = {};
    // A first read settles what is computed once (closures, grants already earned).
    for (const path of endpoints(w)) await t.http().get(path).set(w.viewer.auth).expect(200);
    for (const path of endpoints(w)) {
      counts[path.replace(w.id, ':event').replace(w.friend.userId, ':friend')] =
        await t.queries.during(() => t.http().get(path).set(w.viewer.auth).expect(200));
    }
    for (const path of [
      '/admin/integrity/flags',
      `/admin/live/events/${w.id}`,
      `/admin/live/leaderboards?scope=event&eventId=${w.id}`,
    ]) {
      await t.http().get(path).set(admin).expect(200);
      counts[path.replace(w.id, ':event')] = await t.queries.during(() =>
        t.http().get(path).set(admin).expect(200),
      );
    }
    return counts;
  }

  it('sends the same statements per read for a world of 3 or 30', async () => {
    const hasher = new PasswordHasher({ cost: 2 ** 10 });
    await createAdmin(t.prisma, hasher, {
      email: 'ops@example.com',
      role: 'admin',
      password: PASSWORD,
    });
    const signIn = async () => {
      const res = await t
        .http()
        .post('/admin/auth/sign-in')
        .send({ email: 'ops@example.com', password: PASSWORD });
      return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
    };

    // Both worlds' events exist from the start: the events list grows with active events (a few,
    // scheduled by staff), not with people.
    await event('world-s');
    await event('world-l');
    const small = await world('s', 2);
    const a = await measure(small, await signIn());
    const large = await world('l', 29);
    const b = await measure(large, await signIn());

    console.info(
      Object.keys(a)
        .map((path) => `${path.padEnd(48)} statements 3 people ${a[path]}, 30 people ${b[path]}`)
        .join('\n'),
    );
    expect(b).toEqual(a);
  }, 600_000);
});
