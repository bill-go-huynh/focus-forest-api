import { EventNoticesService } from '../../src/events/event-notices.service.js';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { NotificationsService } from '../../src/notifications/notifications.service.js';
import { RecapNoticesService } from '../../src/notifications/recap-notices.service.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';
import { CHALLENGE_CONFIG_VALUES } from '../support/product-config-values.js';

/**
 * A6.3 social, live, and recap notifications (spec §18; docs/02 Notifications: social and event
 * notifications are informational): room invitations (new), a friend's challenge invitation,
 * challenge updates, an event's start and its last days, a Community Tree badge, and the monthly
 * recap. Every one goes through the A6.1 dispatcher, with the person's choices and blocks.
 */

const t = new ConsistencyHarness('2026-11-02T10:00:00.000Z');
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;
type Body = Record<string, unknown>;
const at = (iso: string) => new Date(iso);

/** A friend challenge each person completes with one session. */
const ONE_SESSION_EACH = {
  id: 'one-session-each',
  kind: 'friend',
  measure: 'sessions',
  goal: 'each',
  target: 1,
  dailyMinutes: 0,
  days: 7,
  maxParticipants: 5,
};

describe('social, live, and recap notifications (A6.3)', () => {
  let notifications: NotificationsService;
  let jobs: JobsService;

  beforeAll(async () => {
    await t.start();
    notifications = t.app.get(NotificationsService);
    jobs = t.app.get(JobsService);
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    t.push.reset();
    await t.activateConfig({
      'challenge.templates': [...CHALLENGE_CONFIG_VALUES['challenge.templates'], ONE_SESSION_EACH],
    });
    await t.setNow('2026-11-02T10:00:00.000Z');
  });

  /** Someone with a username, a device, and every informational category on. */
  async function person(name: string, timeZone = 'UTC') {
    const user = await t.signUp(`${name}@example.com`, timeZone);
    await t.http().patch('/me/profile').set(user.auth).send({ username: name }).expect(200);
    await t
      .http()
      .put(`/me/devices/${encodeURIComponent(`ExponentPushToken[${name}]`)}`)
      .set(user.auth)
      .send({ platform: 'ios' })
      .expect(200);
    await t
      .http()
      .patch('/me/preferences')
      .set(user.auth)
      .send({
        notifications: Object.fromEntries(
          [
            'eventStart',
            'eventEndingSoon',
            'friendInvite',
            'focusRoomInvite',
            'challengeUpdate',
            'badgeUnlocked',
            'monthlyRecapReady',
          ].map((category) => [category, { enabled: true }]),
        ),
      })
      .expect(200);
    return user;
  }
  async function friends(a: User, b: User) {
    await t.http().put(`/me/following/${b.userId}`).set(a.auth).expect(200);
    await t.http().put(`/me/following/${a.userId}`).set(b.auth).expect(200);
  }
  const dispatch = (iso: string) => notifications.dispatchDue(at(iso));
  const pushed = () =>
    t.push.messages.map((m) => [m.to.slice(18, -1), m.data.category, m.title, m.data.link]);
  const outbox = () => t.prisma.notificationOutbox.findMany({ orderBy: { id: 'asc' } });

  describe('room invitations', () => {
    async function privateRoom(host: User) {
      const res = await t
        .http()
        .post('/rooms')
        .set(host.auth)
        .send({
          name: 'Morning reading',
          topic: null,
          durationMinutes: 25,
          maxParticipants: 4,
          visibility: 'private',
        })
        .expect(201);
      return (res.body as { id: string }).id;
    }
    const invite = (host: User, roomId: string, userIds: string[]) =>
      t.http().post(`/rooms/${roomId}/invites`).set(host.auth).send({ userIds });
    const invitations = async (user: User) =>
      (
        (await t.http().get('/me/room-invites').set(user.auth).expect(200)).body as {
          items: Body[];
        }
      ).items;

    it('invites a friend into a private room, who is told, sees it, and joins it by id', async () => {
      const mai = await person('mai');
      const kai = await person('kai');
      await friends(mai, kai);
      const roomId = await privateRoom(mai);

      const room = (await invite(mai, roomId, [kai.userId]).expect(200)).body as Body;
      expect(room['id']).toBe(roomId);

      await dispatch('2026-11-02T10:00:00Z');
      expect(pushed()).toEqual([
        ['kai', 'focusRoomInvite', 'mai invited you to focus', `/together/room/${roomId}`],
      ]);
      expect(t.push.messages[0]!.body).toBe(
        'The room "Morning reading" is gathering. Join if you have time.',
      );

      expect(await invitations(kai)).toEqual([
        {
          room: expect.objectContaining({
            id: roomId,
            name: 'Morning reading',
            code: null,
          }) as Body,
          from: { id: mai.userId, username: 'mai', displayName: null, avatarUrl: null },
          invitedAt: '2026-11-02T10:00:00.000Z',
        },
      ]);
      await t.http().get(`/rooms/${roomId}`).set(kai.auth).expect(200);
      await t.http().post(`/rooms/${roomId}/join`).set(kai.auth).expect(200);
      expect(await invitations(kai)).toEqual([]);
    });

    it('invites only friends who are not blocked, while the room is gathering', async () => {
      const mai = await person('mai');
      const kai = await person('kai');
      const stranger = await person('lee');
      const roomId = await privateRoom(mai);

      // Not friends yet, and then a follow one way only.
      expect((await invite(mai, roomId, [kai.userId]).expect(422)).body).toMatchObject({
        code: 'not_a_friend',
      });
      await t.http().put(`/me/following/${kai.userId}`).set(mai.auth).expect(200);
      await invite(mai, roomId, [kai.userId]).expect(422);
      await friends(mai, kai);
      await t.http().put(`/me/blocks/${mai.userId}`).set(kai.auth).expect(204);
      await invite(mai, roomId, [kai.userId]).expect(422);
      // Someone not in the room cannot invite.
      await friends(stranger, kai);
      await invite(stranger, roomId, [kai.userId]).expect(404);
      expect(await t.prisma.roomInvite.count()).toBe(0);
    });

    it('refuses invitations once the room has started', async () => {
      const mai = await person('mai');
      const kai = await person('kai');
      const bo = await person('bob');
      await friends(mai, kai);
      await friends(mai, bo);
      const roomId = await privateRoom(mai);
      // A room starts with at least two people.
      await invite(mai, roomId, [bo.userId]).expect(200);
      await t.http().post(`/rooms/${roomId}/join`).set(bo.auth).expect(200);
      await t.http().put(`/rooms/${roomId}/ready`).set(bo.auth).expect(200);
      await t.http().post(`/rooms/${roomId}/start`).set(mai.auth).expect(200);
      expect((await invite(mai, roomId, [kai.userId]).expect(409)).body).toMatchObject({
        code: 'room_started',
      });
    });

    it('lets an invitation be declined, and lets it lapse when the room starts', async () => {
      const mai = await person('mai');
      const kai = await person('kai');
      const lin = await person('lin');
      const bo = await person('bob');
      await friends(mai, kai);
      await friends(mai, lin);
      await friends(mai, bo);
      const roomId = await privateRoom(mai);
      await invite(mai, roomId, [kai.userId, lin.userId, bo.userId]).expect(200);
      await t.http().post(`/rooms/${roomId}/join`).set(bo.auth).expect(200);
      await t.http().put(`/rooms/${roomId}/ready`).set(bo.auth).expect(200);

      await t.http().delete(`/me/room-invites/${roomId}`).set(kai.auth).expect(204);
      expect(await invitations(kai)).toEqual([]);
      await t.http().get(`/rooms/${roomId}`).set(kai.auth).expect(404);

      await t.http().post(`/rooms/${roomId}/start`).set(mai.auth).expect(200);
      expect(await invitations(lin)).toEqual([]);
      expect(
        (await t.http().post(`/rooms/${roomId}/join`).set(lin.auth).expect(409)).body,
      ).toMatchObject({
        code: 'room_started',
      });
      // Neither notification is still worth sending.
      await dispatch('2026-11-02T10:00:00Z');
      expect(pushed()).toEqual([]);
      // Bob joined: his invitation is gone too.
      expect((await outbox()).map((row) => row.reason)).toEqual([
        'not_relevant',
        'not_relevant',
        'not_relevant',
      ]);
    });
  });

  describe('challenges', () => {
    const create = async (user: User, invite: string[]) =>
      (
        (
          await t
            .http()
            .post('/me/challenges')
            .set(user.auth)
            .send({ templateId: 'one-session-each', invite })
            .expect(201)
        ).body as { id: string }
      ).id;

    it('tells a friend they were invited, and the inviter when they join', async () => {
      const mai = await person('mai');
      const kai = await person('kai');
      await friends(mai, kai);
      const id = await create(mai, [kai.userId]);
      await dispatch('2026-11-02T10:00:00Z');
      expect(pushed()).toEqual([
        ['kai', 'friendInvite', 'mai invited you to a challenge', `/together/challenges/${id}`],
      ]);

      await t.http().post(`/me/challenges/${id}/accept`).set(kai.auth).expect(200);
      await dispatch('2026-11-02T10:00:00Z');
      expect(pushed()[1]).toEqual([
        'mai',
        'challengeUpdate',
        'kai joined your challenge',
        `/together/challenges/${id}`,
      ]);
    });

    it('drops an invitation already declined', async () => {
      const mai = await person('mai');
      const kai = await person('kai');
      await friends(mai, kai);
      const id = await create(mai, [kai.userId]);
      await t.http().post(`/me/challenges/${id}/decline`).set(kai.auth).expect(204);
      await dispatch('2026-11-02T10:00:00Z');
      expect(pushed()).toEqual([]);
    });

    it('tells the others when a session completes the challenge', async () => {
      const mai = await person('mai');
      const kai = await person('kai');
      await friends(mai, kai);
      const id = await create(mai, [kai.userId]);
      await t.http().post(`/me/challenges/${id}/accept`).set(kai.auth).expect(200);
      await dispatch('2026-11-02T10:00:00Z');
      t.push.reset();

      await t.setNow('2026-11-02T10:30:00.000Z');
      await t.submit(kai, '2026-11-02T10:00:00.000Z', 25).expect(201);
      await jobs.runDue(at('2026-11-02T10:30:00Z'));
      await dispatch('2026-11-02T10:30:00Z');
      expect(pushed()).toEqual([]);

      // Mai's session completes it: Kai hears of it, Mai sees it in the app.
      await t.setNow('2026-11-02T11:00:00.000Z');
      await t.submit(mai, '2026-11-02T10:30:00.000Z', 25).expect(201);
      await jobs.runDue(at('2026-11-02T11:00:00Z'));
      await dispatch('2026-11-02T11:00:00Z');
      expect(pushed()).toEqual([
        ['kai', 'challengeUpdate', 'Your challenge is complete', `/together/challenges/${id}`],
      ]);
      expect((await t.prisma.challenge.findUniqueOrThrow({ where: { id } })).completedAt).toEqual(
        at('2026-11-02T11:00:00Z'),
      );

      // Reading it later changes nothing and tells nobody again.
      await t.http().get(`/me/challenges/${id}`).set(kai.auth).expect(200);
      await dispatch('2026-11-02T11:05:00Z');
      expect(pushed()).toHaveLength(1);
    });
  });

  describe('events', () => {
    async function event(change: Body = {}) {
      await t.prisma.badgeDefinition.create({
        data: {
          id: 'garden-oak:seedling',
          category: 'event',
          rarity: 'common',
          source: 'event',
          availability: 'limited',
          status: 'active',
          availableFrom: at('2026-11-01T00:00:00Z'),
          availableUntil: at('2026-12-31T00:00:00Z'),
          name: 'Garden Oak Seedling',
          description: 'The Garden Oak sprouted.',
          artworkId: 'garden-oak-seedling',
        },
      });
      await t.prisma.event.create({
        data: {
          id: 'autumn-study',
          name: 'Autumn Study Event',
          description: 'Steady autumn focus.',
          artworkId: 'autumn-study',
          status: 'active',
          startsAt: at('2026-11-02T12:00:00Z'),
          endsAt: at('2026-11-16T00:00:00Z'),
          missions: {
            create: [
              {
                id: 'one-hour',
                measure: 'focus_minutes',
                target: 60,
                name: 'Focus 1 hour',
                description: 'One hour.',
              },
            ],
          },
          communityTree: {
            create: {
              name: 'The Garden Oak',
              artworkId: 'garden-oak',
              milestones: {
                create: [
                  { stage: 'seedling', thresholdMinutes: 40, badgeId: 'garden-oak:seedling' },
                ],
              },
            },
          },
          ...change,
        },
      });
    }
    const notices = () => t.app.get(EventNoticesService);

    it('tells everyone who wants to know when an event begins', async () => {
      await event();
      await person('ana');
      const ben = await person('ben');
      await t
        .http()
        .patch('/me/preferences')
        .set(ben.auth)
        .send({ notifications: { eventStart: { enabled: false } } })
        .expect(200);

      await t.setNow('2026-11-02T11:45:00.000Z');
      await notices().plan(at('2026-11-02T11:45:00Z'));
      expect(await t.prisma.notificationOutbox.count()).toBe(0);
      await t.setNow('2026-11-02T12:00:00.000Z');
      await notices().plan(at('2026-11-02T12:00:00Z'));
      await dispatch('2026-11-02T12:00:00Z');
      expect(pushed()).toEqual([
        ['ana', 'eventStart', 'Autumn Study Event has begun', '/together/events/autumn-study'],
      ]);
      // Only those who turned it on are planned for, once.
      await notices().plan(at('2026-11-02T12:00:00Z'));
      expect(await t.prisma.notificationOutbox.count()).toBe(1);
    });

    it('drops the start notice of an event retired before it is sent', async () => {
      await event();
      await person('ana');
      await notices().plan(at('2026-11-02T12:00:00Z'));
      await t.prisma.event.update({ where: { id: 'autumn-study' }, data: { status: 'retired' } });
      await dispatch('2026-11-02T12:00:00Z');
      expect(pushed()).toEqual([]);
    });

    it('tells participants, and only them, two days before the end', async () => {
      await event();
      await t.prisma.event.create({
        data: {
          id: 'winter-study',
          name: 'Winter Study',
          description: 'Steady winter focus.',
          artworkId: 'winter-study',
          status: 'active',
          startsAt: at('2026-11-01T00:00:00Z'),
          endsAt: at('2026-12-20T00:00:00Z'),
        },
      });
      const ana = await person('ana');
      const ben = await person('ben');
      await t.setNow('2026-11-03T10:00:00.000Z');
      await t.http().post('/events/autumn-study/join').set(ana.auth).expect(200);
      // Ben takes part in another event only.
      await t.http().post('/events/winter-study/join').set(ben.auth).expect(200);

      // 48 hours before 16 November 00:00 UTC is 14 November 00:00 UTC.
      await notices().plan(at('2026-11-13T23:45:00Z'));
      expect(await t.prisma.notificationOutbox.count()).toBe(0);
      await notices().plan(at('2026-11-14T00:00:00Z'));
      // 00:00 is outside the day window: it is sent at 09:00.
      await dispatch('2026-11-14T00:00:00Z');
      expect(pushed()).toEqual([]);
      await t.setNow('2026-11-14T09:00:00.000Z');
      await dispatch('2026-11-14T09:00:00Z');
      expect(pushed()).toEqual([
        ['ana', 'eventEndingSoon', 'Autumn Study Event ends soon', '/together/events/autumn-study'],
      ]);
      expect(t.push.messages[0]!.body).toBe('It wraps up soon. Thank you for taking part.');
    });

    it('tells the other participants when the Community Tree reaches a stage with a badge', async () => {
      await event({ startsAt: at('2026-11-02T00:00:00Z') });
      const ana = await person('ana');
      const ben = await person('ben');
      await person('cam');
      for (const user of [ana, ben]) {
        await t.http().post('/events/autumn-study/join').set(user.auth).expect(200);
      }

      await t.submit(ana, '2026-11-02T09:00:00.000Z', 45).expect(201);
      await jobs.runDue(at('2026-11-02T10:00:00Z'));
      await dispatch('2026-11-02T10:00:00Z');
      // Ana sees it on her completion screen; Ben is told; Cam never joined.
      expect(pushed()).toEqual([
        ['ben', 'badgeUnlocked', 'A new badge: Garden Oak Seedling', '/profile/achievements'],
      ]);
    });
  });

  describe('the monthly recap', () => {
    const recaps = () => t.app.get(RecapNoticesService);

    it('says the recap is ready at 09:00 local on the first, to those who focused that month', async () => {
      const ana = await person('ana', 'Asia/Ho_Chi_Minh');
      await person('ben', 'Asia/Ho_Chi_Minh');
      await t.focus(ana, [['2026-10-20', 30]]);

      // 09:00 on 1 November in Ho Chi Minh City is 02:00 UTC.
      await t.setNow('2026-11-01T02:00:00.000Z');
      await recaps().plan(at('2026-11-01T01:45:00Z'));
      expect(await t.prisma.notificationOutbox.count()).toBe(0);
      await recaps().plan(at('2026-11-01T02:00:00Z'));
      await dispatch('2026-11-01T02:00:00Z');
      expect(pushed()).toEqual([
        ['ana', 'monthlyRecapReady', 'Your October recap is ready', '/recap/2026/10'],
      ]);
      await recaps().plan(at('2026-11-01T02:00:00Z'));
      expect(await t.prisma.notificationOutbox.count()).toBe(1);
    });

    it('comes on the first only', async () => {
      const ana = await person('ana');
      await t.focus(ana, [['2026-10-20', 30]]);
      await recaps().plan(at('2026-11-02T09:00:00Z'));
      expect(await t.prisma.notificationOutbox.count()).toBe(0);
    });

    it('is quiet for a month with only discarded sessions', async () => {
      const ana = await person('ana');
      await t.focus(ana, [['2026-10-20', 30, 'discarded']]);
      await recaps().plan(at('2026-11-01T09:00:00Z'));
      expect(await t.prisma.notificationOutbox.count()).toBe(0);
    });
  });
});
