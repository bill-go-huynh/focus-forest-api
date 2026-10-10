import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A5.4 Focus Together (spec §14, docs/02 Focus Together, docs/07 §6): rooms, the lobby, ready-up,
 * a server-decided start, per-participant sessions, completion, leaving without blame, badges,
 * and admin oversight.
 */

const NOW = '2026-10-10T10:00:00.000Z';
const t = new ConsistencyHarness(NOW);
const hasher = new PasswordHasher({ cost: 2 ** 10 });
type Auth = Record<string, string>;
interface User {
  userId: string;
  auth: Auth;
  topicId: string;
}
type Body = Record<string, unknown>;
interface Participant {
  user: { id: string; username: string | null };
  host: boolean;
  state: string;
}
interface Room {
  id: string;
  code: string | null;
  name: string;
  phase: string;
  startsAt: string | null;
  endsAt: string | null;
  participants: Participant[];
  you: { host: boolean; state: string } | null;
}

async function person(name: string): Promise<User> {
  const user = await t.signUp(`${name}@example.com`);
  await t
    .http()
    .patch('/me/profile')
    .set(user.auth)
    .send({ username: name, displayName: name })
    .expect(200);
  return user;
}
const create = (user: User, body: Body = {}) =>
  t
    .http()
    .post('/rooms')
    .set(user.auth)
    .send({
      name: 'Morning study',
      durationMinutes: 25,
      maxParticipants: 4,
      visibility: 'private',
      ...body,
    });
const room = (res: { body: unknown }) => res.body as Room;
const join = (user: User, code: string) =>
  t.http().post('/rooms/join').set(user.auth).send({ code });
const ready = (user: User, id: string) => t.http().put(`/rooms/${id}/ready`).set(user.auth);
const unready = (user: User, id: string) => t.http().delete(`/rooms/${id}/ready`).set(user.auth);
const leave = (user: User, id: string) => t.http().post(`/rooms/${id}/leave`).set(user.auth);
const view = (user: User, id: string) => t.http().get(`/rooms/${id}`).set(user.auth);
const states = (r: Room) => r.participants.map((p) => [p.user.username, p.state, p.host]);

/** Ada (host) and Bob, both ready: the room starts 10 s later. */
async function started(extra: Body = {}) {
  const ada = await person('ada');
  const bob = await person('bob');
  const created = room(await create(ada, extra).expect(201));
  await join(bob, created.code!).expect(200);
  await ready(ada, created.id).expect(200);
  const res = room(await ready(bob, created.id).expect(200));
  return { ada, bob, id: created.id, room: res };
}

describe('Focus Together (A5.4, HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow(NOW);
    await t.activateConfig();
  });

  describe('creating a room', () => {
    it('makes the creator the host of a lobby with a share code', async () => {
      const ada = await person('ada');
      const res = await create(ada, { topic: '  Exam prep ' }).expect(201);
      expect(res.body).toEqual({
        id: expect.any(String) as string,
        code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/) as string,
        name: 'Morning study',
        topic: 'Exam prep',
        durationMinutes: 25,
        maxParticipants: 4,
        visibility: 'private',
        phase: 'lobby',
        startsAt: null,
        endsAt: null,
        participants: [
          {
            user: { id: ada.userId, username: 'ada', displayName: 'ada', avatarUrl: null },
            host: true,
            state: 'waiting',
          },
        ],
        you: { host: true, state: 'waiting' },
      });
    });

    it('validates the settings', async () => {
      const ada = await person('ada');
      for (const body of [
        { name: '' },
        { name: 'x'.repeat(51) },
        { durationMinutes: 4 },
        { durationMinutes: 181 },
        { durationMinutes: 25.5 },
        { maxParticipants: 1 },
        { maxParticipants: 11 },
        { visibility: 'friends' },
        { topic: 'x'.repeat(51) },
      ]) {
        await create(ada, body).expect(400);
      }
    });

    it('allows one active room per person', async () => {
      const ada = await person('ada');
      await create(ada).expect(201);
      const again = await create(ada).expect(409);
      expect(again.body).toMatchObject({ code: 'already_in_room' });
      const current = (await t.http().get('/rooms/current').set(ada.auth).expect(200)).body as {
        room: Room | null;
      };
      expect(current.room?.name).toBe('Morning study');
    });
  });

  describe('joining', () => {
    it('joins by code; public lobbies are listed, private ones never', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      const priv = room(await create(ada).expect(201));
      const pub = room(await create(bob, { name: 'Open hall', visibility: 'public' }).expect(201));
      const listed = (await t.http().get('/rooms').set(cyd.auth).expect(200)).body as {
        items: Room[];
      };
      expect(listed.items.map((r) => r.name)).toEqual(['Open hall']);
      expect(listed.items[0]!.code).toBeNull();

      const joined = room(await join(cyd, priv.code!.toLowerCase()).expect(200));
      expect(states(joined)).toEqual([
        ['ada', 'waiting', true],
        ['cyd', 'waiting', false],
      ]);
      expect(joined.you).toEqual({ host: false, state: 'waiting' });
      await leave(cyd, priv.id).expect(200);
      await t.http().post(`/rooms/${pub.id}/join`).set(cyd.auth).expect(200);
      await join(cyd, 'ZZZZZZ').expect(404);
    });

    it('hides a private room from non-members and the code from visitors', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const priv = room(await create(ada).expect(201));
      await view(bob, priv.id).expect(404);
      await t.http().post(`/rooms/${priv.id}/join`).set(bob.auth).expect(404);
      await leave(ada, priv.id).expect(200);
      const pub = room(await create(ada, { visibility: 'public' }).expect(201));
      expect(room(await view(bob, pub.id).expect(200))).toMatchObject({ code: null, you: null });
    });

    it('refuses a full room, a started room, and a second room', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      const small = room(await create(ada, { maxParticipants: 2 }).expect(201));
      await join(bob, small.code!).expect(200);
      const full = await join(cyd, small.code!).expect(409);
      expect(full.body).toMatchObject({ code: 'room_full' });
      const other = room(await create(cyd).expect(201));
      const second = await join(bob, other.code!).expect(409);
      expect(second.body).toMatchObject({ code: 'already_in_room' });

      await ready(ada, small.id).expect(200);
      await ready(bob, small.id).expect(200);
      await leave(cyd, other.id).expect(200);
      const late = await join(cyd, small.code!).expect(409);
      expect(late.body).toMatchObject({ code: 'room_started' });
    });

    it('keeps blocked users apart: no join, no listing', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      const pub = room(await create(ada, { visibility: 'public' }).expect(201));
      await t.http().put(`/me/blocks/${bob.userId}`).set(ada.auth).expect(204);
      await join(bob, pub.code!).expect(404);
      expect(
        ((await t.http().get('/rooms').set(bob.auth).expect(200)).body as Body)['items'],
      ).toEqual([]);
      await join(cyd, pub.code!).expect(200);
      // Bob also may not join a room where someone he blocked is waiting.
      await t.http().delete(`/me/blocks/${bob.userId}`).set(ada.auth).expect(204);
      await t.http().put(`/me/blocks/${cyd.userId}`).set(bob.auth).expect(204);
      await join(bob, pub.code!).expect(404);
    });

    it('fills the last place once when two join at the same time', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      const small = room(await create(ada, { maxParticipants: 2 }).expect(201));
      const results = await Promise.all([join(bob, small.code!), join(cyd, small.code!)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(room(await view(ada, small.id).expect(200)).participants).toHaveLength(2);
    });
  });

  describe('ready and start', () => {
    it('starts on its own when everyone present is ready, 10 seconds later', async () => {
      const { ada, room: r } = await started();
      expect(r).toMatchObject({
        phase: 'countdown',
        startsAt: '2026-10-10T10:00:10.000Z',
        endsAt: '2026-10-10T10:25:10.000Z',
      });
      expect(states(r)).toEqual([
        ['ada', 'focusing', true],
        ['bob', 'focusing', false],
      ]);
      await t.setNow('2026-10-10T10:00:10.000Z');
      expect(room(await view(ada, r.id).expect(200)).phase).toBe('focusing');
    });

    it('can be unready, and the host can start with the ready ones', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      const r = room(await create(ada).expect(201));
      await join(bob, r.code!).expect(200);
      await join(cyd, r.code!).expect(200);
      await ready(bob, r.id).expect(200);
      expect(states(room(await unready(bob, r.id).expect(200)))[1]).toEqual([
        'bob',
        'waiting',
        false,
      ]);
      await ready(bob, r.id).expect(200);

      const notHost = await t.http().post(`/rooms/${r.id}/start`).set(bob.auth).expect(403);
      expect(notHost.body).toMatchObject({ code: 'not_room_host' });
      const res = room(await t.http().post(`/rooms/${r.id}/start`).set(ada.auth).expect(200));
      // The host's start makes them ready; Cyd was not ready and leaves the room quietly.
      expect(states(res)).toEqual([
        ['ada', 'focusing', true],
        ['bob', 'focusing', false],
      ]);
      await create(cyd).expect(201);
    });

    it('needs two ready people to start', async () => {
      const ada = await person('ada');
      const r = room(await create(ada).expect(201));
      const alone = await t.http().post(`/rooms/${r.id}/start`).set(ada.auth).expect(409);
      expect(alone.body).toMatchObject({ code: 'not_enough_ready' });
    });
  });

  describe('leaving', () => {
    it('passes the host on, and closes an empty lobby', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const r = room(await create(ada).expect(201));
      await join(bob, r.code!).expect(200);
      const after = room(await leave(ada, r.id).expect(200));
      expect(states(after)).toEqual([['bob', 'waiting', true]]);
      const closed = room(await leave(bob, r.id).expect(200));
      expect(closed.phase).toBe('closed');
      await join(ada, r.code!).expect(404);
    });

    it('during focus: the person quietly disappears, with no blame anywhere', async () => {
      const { ada, bob, id } = await started();
      await t.setNow('2026-10-10T10:05:00.000Z');
      await leave(bob, id).expect(200);
      const seen = room(await view(ada, id).expect(200));
      expect(states(seen)).toEqual([['ada', 'focusing', true]]);
      expect(JSON.stringify(seen)).not.toMatch(/left|quit|abandon/i);
      // Bob is free for another room.
      await create(bob).expect(201);
    });
  });

  describe('completing', () => {
    it('links each person’s own counted session; badges come after focus', async () => {
      const { ada, bob, id } = await started();
      await t.setNow('2026-10-10T10:26:00.000Z');
      const adaSession = await t.submit(ada, '2026-10-10T10:00:10.000Z', 25).expect(201);
      const sessionId = (adaSession.body as { id: string }).id;
      // The session grows Ada's own tree, as any session does.
      expect((adaSession.body as { growth: unknown }).growth).not.toBeNull();

      const done = await t
        .http()
        .post(`/rooms/${id}/complete`)
        .set(ada.auth)
        .send({ sessionId })
        .expect(200);
      const body = done.body as {
        room: Room;
        progression: { newlyEarnedBadges: { id: string }[] };
      };
      expect(states(body.room)).toEqual([
        ['ada', 'completed', true],
        ['bob', 'focusing', false],
      ]);
      expect(body.progression.newlyEarnedBadges.map((b) => b.id)).toEqual(['focus-together:first']);

      const again = await t
        .http()
        .post(`/rooms/${id}/complete`)
        .set(ada.auth)
        .send({ sessionId })
        .expect(200);
      expect((again.body as typeof body).progression.newlyEarnedBadges).toEqual([]);
      expect(await t.prisma.userBadge.count({ where: { userId: ada.userId } })).toBeGreaterThan(0);

      await t.setNow('2026-10-10T10:40:00.000Z');
      const other = (await t.submit(ada, '2026-10-10T10:30:00.000Z', 5).expect(201)).body as {
        id: string;
      };
      const twice = await t
        .http()
        .post(`/rooms/${id}/complete`)
        .set(ada.auth)
        .send({ sessionId: other.id })
        .expect(409);
      expect(twice.body).toMatchObject({ code: 'already_completed' });
      // Bob is still focusing: nothing of Ada's completion changes his place.
      expect(states(room(await view(bob, id).expect(200)))[1]).toEqual(['bob', 'focusing', false]);
    });

    it('earns Focus Buddy when a friend focused in the same room', async () => {
      const { ada, bob, id } = await started();
      await t.http().put(`/me/following/${bob.userId}`).set(ada.auth).expect(200);
      await t.http().put(`/me/following/${ada.userId}`).set(bob.auth).expect(200);
      await t.setNow('2026-10-10T10:26:00.000Z');
      const s = (await t.submit(bob, '2026-10-10T10:00:12.000Z', 25).expect(201)).body as {
        id: string;
      };
      const res = await t
        .http()
        .post(`/rooms/${id}/complete`)
        .set(bob.auth)
        .send({ sessionId: s.id })
        .expect(200);
      expect(
        (
          res.body as { progression: { newlyEarnedBadges: { id: string }[] } }
        ).progression.newlyEarnedBadges.map((b) => b.id),
      ).toEqual(['focus-together:first', 'focus-buddy']);
      const achievements = (await t.http().get('/me/achievements').set(bob.auth).expect(200))
        .body as { items: { id: string; completed: boolean; current: number; unit: string }[] };
      const together = achievements.items.filter((a) =>
        ['focus-together:first', 'focus-buddy'].includes(a.id),
      );
      expect(together.map((a) => [a.id, a.completed, a.current, a.unit])).toEqual([
        ['focus-together:first', true, 1, 'sessions'],
        ['focus-buddy', true, 1, 'sessions'],
      ]);
      // Ada has not completed: no progress for her yet.
      const hers = (await t.http().get('/me/achievements').set(ada.auth).expect(200)).body as {
        items: { id: string; completed: boolean }[];
      };
      expect(hers.items.find((a) => a.id === 'focus-together:first')?.completed).toBe(false);
    });

    it('refuses sessions that are not this person’s counted focus of this room', async () => {
      const { ada, bob, id } = await started();
      await t.setNow('2026-10-10T10:40:00.000Z');
      const short = (await t.submit(ada, '2026-10-10T10:00:10.000Z', 2).expect(201)).body as {
        id: string;
      };
      const notCounted = await t
        .http()
        .post(`/rooms/${id}/complete`)
        .set(ada.auth)
        .send({ sessionId: short.id })
        .expect(422);
      expect(notCounted.body).toMatchObject({ code: 'session_not_counted' });
      const early = (await t.submit(ada, '2026-10-10T09:00:00.000Z', 30).expect(201)).body as {
        id: string;
      };
      const elsewhere = await t
        .http()
        .post(`/rooms/${id}/complete`)
        .set(ada.auth)
        .send({ sessionId: early.id })
        .expect(422);
      expect(elsewhere.body).toMatchObject({ code: 'session_not_in_room' });
      const bobs = (await t.submit(bob, '2026-10-10T10:00:10.000Z', 25).expect(201)).body as {
        id: string;
      };
      await t
        .http()
        .post(`/rooms/${id}/complete`)
        .set(ada.auth)
        .send({ sessionId: bobs.id })
        .expect(404);
      const stranger = await person('cyd');
      await t
        .http()
        .post(`/rooms/${id}/complete`)
        .set(stranger.auth)
        .send({ sessionId: bobs.id })
        .expect(404);
    });

    it('gives no completion to someone who left during focus; their session is still theirs', async () => {
      const { bob, id } = await started();
      await t.setNow('2026-10-10T10:10:00.000Z');
      await leave(bob, id).expect(200);
      const s = (await t.submit(bob, '2026-10-10T10:00:10.000Z', 9).expect(201)).body as {
        id: string;
      };
      const res = await t
        .http()
        .post(`/rooms/${id}/complete`)
        .set(bob.auth)
        .send({ sessionId: s.id })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'not_in_session' });
      expect(await t.prisma.focusSession.count({ where: { userId: bob.userId } })).toBe(1);
    });

    it('needs a mutual follow who started in the room for Focus Buddy', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      // Ada follows Bob, who does not follow back: not friends, in either direction.
      // Cyd is Ada's friend but never starts with her (not ready when the host starts).
      await t.http().put(`/me/following/${bob.userId}`).set(ada.auth).expect(200);
      await t.http().put(`/me/following/${cyd.userId}`).set(ada.auth).expect(200);
      await t.http().put(`/me/following/${ada.userId}`).set(cyd.auth).expect(200);
      const r = room(await create(ada).expect(201));
      await join(bob, r.code!).expect(200);
      await join(cyd, r.code!).expect(200);
      await ready(bob, r.id).expect(200);
      await t.http().post(`/rooms/${r.id}/start`).set(ada.auth).expect(200);
      await t.setNow('2026-10-10T10:26:00.000Z');
      for (const [user, start] of [
        [ada, '2026-10-10T10:00:10.000Z'],
        [bob, '2026-10-10T10:00:11.000Z'],
      ] as const) {
        const s = (await t.submit(user, start, 25).expect(201)).body as { id: string };
        const res = await t
          .http()
          .post(`/rooms/${r.id}/complete`)
          .set(user.auth)
          .send({ sessionId: s.id })
          .expect(200);
        expect(
          (
            res.body as { progression: { newlyEarnedBadges: { id: string }[] } }
          ).progression.newlyEarnedBadges.map((b) => b.id),
        ).toEqual(['focus-together:first']);
      }
    });

    it('ends after the duration plus the pause allowance; late completions still count', async () => {
      const { ada, id } = await started();
      await t.setNow('2026-10-10T10:55:10.000Z');
      expect(room(await view(ada, id).expect(200)).phase).toBe('ended');
      const current = (await t.http().get('/rooms/current').set(ada.auth).expect(200)).body as {
        room: Room | null;
      };
      expect(current.room).toBeNull();
      await create(ada).expect(201);
      const s = (await t.submit(ada, '2026-10-10T10:00:10.000Z', 25).expect(201)).body as {
        id: string;
      };
      await t
        .http()
        .post(`/rooms/${id}/complete`)
        .set(ada.auth)
        .send({ sessionId: s.id })
        .expect(200);
    });
  });

  describe('admin oversight', () => {
    async function admin(email: string, role: 'admin' | 'support' | 'moderator'): Promise<Auth> {
      await createAdmin(t.prisma, hasher, {
        email,
        role,
        password: 'correct horse battery staple',
      });
      const res = await t
        .http()
        .post('/admin/auth/sign-in')
        .send({ email, password: 'correct horse battery staple' });
      return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
    }

    it('lists active rooms and closes one with a reason, audited', async () => {
      const { ada, id } = await started({ name: 'Rude name' });
      const moderator = await admin('mod@example.com', 'moderator');
      const support = await admin('support@example.com', 'support');
      await t.http().get('/admin/rooms').set(support).expect(403);
      const list = (await t.http().get('/admin/rooms').set(moderator).expect(200)).body as {
        items: Body[];
      };
      expect(list.items).toEqual([
        {
          id,
          name: 'Rude name',
          topic: null,
          visibility: 'private',
          phase: 'countdown',
          participants: 2,
          host: { id: ada.userId, email: 'ada@example.com', username: 'ada' },
          createdAt: NOW,
        },
      ]);
      await t.http().post(`/admin/rooms/${id}/close`).set(moderator).send({}).expect(400);
      const closed = await t
        .http()
        .post(`/admin/rooms/${id}/close`)
        .set(moderator)
        .send({ reason: 'Offensive name' })
        .expect(200);
      expect(closed.body).toMatchObject({ id, phase: 'closed' });
      await t
        .http()
        .post(`/admin/rooms/${id}/close`)
        .set(moderator)
        .send({ reason: 'again' })
        .expect(409);
      const log = await t.prisma.adminAuditLog.findMany({ where: { action: 'room.close' } });
      expect(log.map((row) => [row.targetId, row.reason])).toEqual([[id, 'Offensive name']]);

      expect(room(await view(ada, id).expect(200)).phase).toBe('closed');
      await t.setNow('2026-10-10T10:26:00.000Z');
      const s = (await t.submit(ada, '2026-10-10T10:00:10.000Z', 25).expect(201)).body as {
        id: string;
      };
      const refused = await t
        .http()
        .post(`/rooms/${id}/complete`)
        .set(ada.auth)
        .send({ sessionId: s.id })
        .expect(409);
      expect(refused.body).toMatchObject({ code: 'room_closed' });
      // Her session still counts for her own tree: closing a room never touches sessions.
      expect(await t.prisma.focusSession.count({ where: { userId: ada.userId } })).toBe(1);
    });
  });

  it('removes a person’s places with their account; the room goes on', async () => {
    const { ada, bob, id } = await started();
    await t.prisma.user.delete({ where: { id: ada.userId } });
    const seen = room(await view(bob, id).expect(200));
    expect(states(seen)).toEqual([['bob', 'focusing', true]]);
  });
});
