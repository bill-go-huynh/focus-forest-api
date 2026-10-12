import { randomUUID } from 'node:crypto';

import { JobsService } from '../../src/jobs/jobs.service.js';
import { BackgroundWorker } from '../../src/notifications/background-worker.js';
import {
  type NewNotification,
  NotificationsService,
} from '../../src/notifications/notifications.service.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A6.1 notification foundation (spec §18; docs/02 Notifications; docs/11 Notification control;
 * docs/07 device registration): devices, the focus lease, and one dispatcher that sends only
 * what the person turned on, never during focus, within the daily limit and the day window.
 */

const t = new ConsistencyHarness('2026-11-02T10:00:00.000Z');
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;
const at = (iso: string) => new Date(iso);
const TOKEN = 'ExponentPushToken[abc123]';

describe('notification foundation (A6.1)', () => {
  let notifications: NotificationsService;
  let jobs: JobsService;
  let relevant = true;

  beforeAll(async () => {
    await t.start();
    notifications = t.app.get(NotificationsService);
    jobs = t.app.get(JobsService);
    notifications.registerRelevance('challengeUpdate', () => Promise.resolve(relevant));
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    t.push.reset();
    relevant = true;
    await t.activateConfig();
    await t.setNow('2026-11-02T10:00:00.000Z');
  });

  const device = (user: User, token = TOKEN, platform = 'ios') =>
    t
      .http()
      .put(`/me/devices/${encodeURIComponent(token)}`)
      .set(user.auth)
      .send({ platform });

  const turnOn = (user: User, ...categories: string[]) =>
    t
      .http()
      .patch('/me/preferences')
      .set(user.auth)
      .send({
        notifications: Object.fromEntries(categories.map((c) => [c, { enabled: true }])),
      })
      .expect(200);

  /** Someone with a device and the event categories on. */
  async function person(email = 'ana@example.com', timeZone = 'UTC') {
    const user = await t.signUp(email, timeZone);
    await device(user, `ExponentPushToken[${email.split('@')[0]}]`).expect(200);
    await turnOn(user, 'eventStart', 'challengeUpdate');
    await t
      .http()
      .patch('/me/preferences')
      .set(user.auth)
      .send({ notifications: { scheduledFocusReminder: { enabled: true, time: '10:00' } } })
      .expect(200);
    return user;
  }

  const notice = (user: User, change: Partial<NewNotification> = {}): NewNotification => ({
    userId: user.userId,
    category: 'eventStart',
    dedupeKey: `event-start:${randomUUID()}`,
    subject: 'autumn-study-2026',
    copy: { category: 'eventStart', eventName: 'Autumn Study Event' },
    link: '/together/events/autumn-study-2026',
    requested: false,
    notBefore: at('2026-11-02T10:00:00Z'),
    expiresAt: at('2026-11-03T10:00:00Z'),
    ...change,
  });

  const outbox = () => t.prisma.notificationOutbox.findMany({ orderBy: { id: 'asc' } });

  describe('devices', () => {
    it('registers a device, and refreshes it on the next registration', async () => {
      const ana = await t.signUp('ana@example.com');
      const res = await device(ana).expect(200);
      expect(res.body).toEqual({
        token: TOKEN,
        platform: 'ios',
        registeredAt: '2026-11-02T10:00:00.000Z',
      });

      await t.setNow('2026-11-05T08:00:00.000Z');
      await t
        .http()
        .put(`/me/devices/${encodeURIComponent(TOKEN)}`)
        .set(ana.auth)
        .send({ platform: 'ios', appVersion: '1.2.0' })
        .expect(200);
      expect(await t.prisma.pushDevice.findMany()).toEqual([
        expect.objectContaining({
          token: TOKEN,
          userId: ana.userId,
          appVersion: '1.2.0',
          registeredAt: at('2026-11-02T10:00:00Z'),
          lastSeenAt: at('2026-11-05T08:00:00Z'),
        }),
      ]);
    });

    it('moves a device to whoever signs in on it', async () => {
      const ana = await t.signUp('ana@example.com');
      const ben = await t.signUp('ben@example.com');
      await device(ana).expect(200);
      await device(ben, TOKEN, 'android').expect(200);
      expect(await t.prisma.pushDevice.findMany()).toEqual([
        expect.objectContaining({ token: TOKEN, userId: ben.userId, platform: 'android' }),
      ]);
    });

    it('refuses what is not an Expo push token or a known platform', async () => {
      const ana = await t.signUp('ana@example.com');
      await device(ana, 'not-a-token').expect(400);
      await device(ana, 'ExponentPushToken[]').expect(400);
      await device(ana, TOKEN, 'windows').expect(400);
      expect(await t.prisma.pushDevice.count()).toBe(0);
    });

    it('forgets a device on sign-out, but never someone else’s', async () => {
      const ana = await t.signUp('ana@example.com');
      const ben = await t.signUp('ben@example.com');
      await device(ana).expect(200);
      await t
        .http()
        .delete(`/me/devices/${encodeURIComponent(TOKEN)}`)
        .set(ben.auth)
        .expect(204);
      expect(await t.prisma.pushDevice.count()).toBe(1);
      await t
        .http()
        .delete(`/me/devices/${encodeURIComponent(TOKEN)}`)
        .set(ana.auth)
        .expect(204);
      await t
        .http()
        .delete(`/me/devices/${encodeURIComponent(TOKEN)}`)
        .set(ana.auth)
        .expect(204);
      expect(await t.prisma.pushDevice.count()).toBe(0);
    });
  });

  describe('the focus lease', () => {
    it('is set while focusing and cleared after', async () => {
      const ana = await t.signUp('ana@example.com');
      const res = await t
        .http()
        .put('/me/focus/active')
        .set(ana.auth)
        .send({ endsAt: '2026-11-02T10:25:00.000Z' })
        .expect(200);
      expect(res.body).toEqual({ endsAt: '2026-11-02T10:25:00.000Z' });
      expect(await t.prisma.focusLease.findUnique({ where: { userId: ana.userId } })).toMatchObject(
        { startedAt: at('2026-11-02T10:00:00Z'), endsAt: at('2026-11-02T10:25:00Z') },
      );

      await t.http().delete('/me/focus/active').set(ana.auth).expect(204);
      await t.http().delete('/me/focus/active').set(ana.auth).expect(204);
      expect(await t.prisma.focusLease.count()).toBe(0);
    });

    it('accepts an end in the next 24 hours only', async () => {
      const ana = await t.signUp('ana@example.com');
      for (const endsAt of ['2026-11-02T09:59:00.000Z', '2026-11-03T10:00:01.000Z', 'soon']) {
        await t.http().put('/me/focus/active').set(ana.auth).send({ endsAt }).expect(400);
      }
      expect(await t.prisma.focusLease.count()).toBe(0);
    });
  });

  describe('dispatching', () => {
    it('sends a notification to every device, with its copy and link', async () => {
      const ana = await person();
      await device(ana, 'ExponentPushToken[second]', 'android').expect(200);

      expect(await notifications.enqueue(t.prisma, notice(ana))).toBe(true);
      expect(await notifications.dispatchDue(at('2026-11-02T10:00:00Z'))).toMatchObject({
        sent: 1,
      });

      expect(t.push.messages).toEqual(
        expect.arrayContaining(
          ['ExponentPushToken[ana]', 'ExponentPushToken[second]'].map((to) => ({
            to,
            title: 'Autumn Study Event has begun',
            body: expect.any(String) as string,
            data: { link: '/together/events/autumn-study-2026', category: 'eventStart' },
          })),
        ),
      );
      expect(t.push.messages).toHaveLength(2);
      expect(await outbox()).toEqual([
        expect.objectContaining({
          status: 'sent',
          sentAt: at('2026-11-02T10:00:00Z'),
          reason: null,
        }),
      ]);
      // Sent once: a second dispatch finds nothing.
      expect(await notifications.dispatchDue(at('2026-11-02T10:05:00Z'))).toMatchObject({
        sent: 0,
      });
      expect(t.push.messages).toHaveLength(2);
    });

    it('stores one notification per dedupe key', async () => {
      const ana = await person();
      const once = notice(ana, { dedupeKey: 'event-start:autumn-study-2026' });
      expect(await notifications.enqueue(t.prisma, once)).toBe(true);
      expect(await notifications.enqueue(t.prisma, once)).toBe(false);
      expect(await t.prisma.notificationOutbox.count()).toBe(1);
    });

    it('refuses a link the app does not know', async () => {
      const ana = await person();
      await expect(
        notifications.enqueue(t.prisma, notice(ana, { link: 'https://example.com' })),
      ).rejects.toThrow(/link/);
    });

    it('refuses copy written for another category', async () => {
      const ana = await person();
      await expect(
        notifications.enqueue(t.prisma, notice(ana, { category: 'challengeUpdate' })),
      ).rejects.toThrow(/copy/);
    });

    it('is run by the worker, after due jobs', async () => {
      const ana = await person();
      await notifications.enqueue(t.prisma, notice(ana));
      await t.app.get(BackgroundWorker).tick(at('2026-11-02T10:00:00Z'));
      expect(t.push.messages).toHaveLength(1);
    });

    it('waits for its time', async () => {
      const ana = await person();
      await notifications.enqueue(t.prisma, notice(ana, { notBefore: at('2026-11-02T12:00:00Z') }));
      await notifications.dispatchDue(at('2026-11-02T11:59:00Z'));
      expect(t.push.messages).toHaveLength(0);
      await notifications.dispatchDue(at('2026-11-02T12:00:00Z'));
      expect(t.push.messages).toHaveLength(1);
    });

    it('skips, with the reason kept, what must not be sent', async () => {
      const ana = await person();
      const quiet = await t.signUp('quiet@example.com');
      await device(quiet).expect(200);
      const noDevice = await t.signUp('nodevice@example.com');
      await turnOn(noDevice, 'eventStart');
      const suspended = await person('sus@example.com');
      await t.prisma.user.update({
        where: { id: suspended.userId },
        data: { status: 'suspended' },
      });

      await notifications.enqueue(t.prisma, notice(quiet));
      await notifications.enqueue(t.prisma, notice(noDevice));
      await notifications.enqueue(t.prisma, notice(suspended));
      await notifications.enqueue(t.prisma, notice(ana, { expiresAt: at('2026-11-02T10:00:00Z') }));
      relevant = false;
      await notifications.enqueue(
        t.prisma,
        notice(ana, {
          category: 'challengeUpdate',
          copy: { category: 'challengeUpdate', kind: 'completed', challengeName: 'Ten hours each' },
          link: '/',
        }),
      );

      expect(await notifications.dispatchDue(at('2026-11-02T10:00:00Z'))).toMatchObject({
        sent: 0,
        skipped: 5,
      });
      expect(t.push.messages).toHaveLength(0);
      const reasons = (await outbox()).map((row) => [row.status, row.reason]);
      expect(reasons).toEqual([
        ['skipped', 'category_off'],
        ['skipped', 'no_device'],
        ['skipped', 'user_inactive'],
        ['skipped', 'expired'],
        ['skipped', 'not_relevant'],
      ]);
    });

    it('waits until focus ends, plus the grace, and sends nothing during it (docs/02)', async () => {
      const ana = await person();
      await t
        .http()
        .put('/me/focus/active')
        .set(ana.auth)
        .send({ endsAt: '2026-11-02T10:25:00.000Z' })
        .expect(200);
      await notifications.enqueue(t.prisma, notice(ana));

      expect(await notifications.dispatchDue(at('2026-11-02T10:00:00Z'))).toMatchObject({
        deferred: 1,
      });
      expect(t.push.messages).toHaveLength(0);
      // The lease ends at 10:25; the grace (30 minutes) covers pauses.
      expect((await outbox())[0]).toMatchObject({
        status: 'pending',
        notBefore: at('2026-11-02T10:55:00Z'),
      });
      await notifications.dispatchDue(at('2026-11-02T10:54:00Z'));
      expect(t.push.messages).toHaveLength(0);
      await notifications.dispatchDue(at('2026-11-02T10:55:00Z'));
      expect(t.push.messages).toHaveLength(1);
    });

    it('sends what focus held back as soon as the focus lease is cleared', async () => {
      const ana = await person();
      await t
        .http()
        .put('/me/focus/active')
        .set(ana.auth)
        .send({ endsAt: '2026-11-02T10:25:00.000Z' })
        .expect(200);
      await notifications.enqueue(t.prisma, notice(ana));
      await notifications.enqueue(t.prisma, notice(ana, { notBefore: at('2026-11-02T13:00:00Z') }));
      await notifications.dispatchDue(at('2026-11-02T10:00:00Z'));
      expect(t.push.messages).toHaveLength(0);

      // The session ended early at 10:12: what focus held back is due again, nothing else moves.
      await t.setNow('2026-11-02T10:12:00.000Z');
      await t.http().delete('/me/focus/active').set(ana.auth).expect(204);
      expect((await outbox()).map((row) => row.notBefore)).toEqual([
        at('2026-11-02T10:12:00Z'),
        at('2026-11-02T13:00:00Z'),
      ]);
      await notifications.dispatchDue(at('2026-11-02T10:12:00Z'));
      expect(t.push.messages).toHaveLength(1);
    });

    it('treats a Focus Together session as focus', async () => {
      const ana = await person();
      const roomId = randomUUID();
      await t.prisma.focusRoom.create({
        data: {
          id: roomId,
          code: 'ABCDEF',
          name: 'Morning',
          durationMinutes: 25,
          maxParticipants: 4,
          visibility: 'public',
          status: 'in_session',
          createdAt: at('2026-11-02T09:50:00Z'),
          startsAt: at('2026-11-02T09:55:00Z'),
          participants: { create: { userId: ana.userId, joinedAt: at('2026-11-02T09:50:00Z') } },
        },
      });
      await notifications.enqueue(t.prisma, notice(ana));

      await notifications.dispatchDue(at('2026-11-02T10:00:00Z'));
      expect(t.push.messages).toHaveLength(0);
      // The room ends after its duration and the pause allowance: 09:55 + 25 + 30 minutes.
      expect((await outbox())[0]!.notBefore).toEqual(at('2026-11-02T10:50:00Z'));
      await notifications.dispatchDue(at('2026-11-02T10:50:00Z'));
      expect(t.push.messages).toHaveLength(1);
    });

    it('holds informational notices until 09:00 local, but sends a reminder at its own time', async () => {
      const ana = await person('ana@example.com', 'Asia/Ho_Chi_Minh');
      // 15:30 UTC is 22:30 in Ho Chi Minh City.
      await notifications.enqueue(t.prisma, notice(ana, { notBefore: at('2026-11-02T15:30:00Z') }));
      await notifications.enqueue(
        t.prisma,
        notice(ana, {
          category: 'scheduledFocusReminder',
          dedupeKey: 'reminder:scheduledFocusReminder:2026-11-02:10:00',
          subject: '2026-11-02 10:00',
          copy: { category: 'scheduledFocusReminder' },
          link: '/',
          requested: true,
          notBefore: at('2026-11-02T15:30:00Z'),
        }),
      );

      await notifications.dispatchDue(at('2026-11-02T15:30:00Z'));
      expect(t.push.messages.map((m) => m.data.category)).toEqual(['scheduledFocusReminder']);
      expect((await outbox())[0]).toMatchObject({
        status: 'pending',
        notBefore: at('2026-11-03T02:00:00Z'),
      });
      await notifications.dispatchDue(at('2026-11-03T02:00:00Z'));
      expect(t.push.messages.map((m) => m.data.category)).toEqual([
        'scheduledFocusReminder',
        'eventStart',
      ]);
    });

    it('sends at most two informational notices a local day; reminders are not counted', async () => {
      const ana = await person();
      // The reminder goes first: it must not use up the informational allowance.
      await notifications.enqueue(
        t.prisma,
        notice(ana, {
          category: 'scheduledFocusReminder',
          dedupeKey: 'reminder:scheduledFocusReminder:2026-11-02:10:00',
          subject: '2026-11-02 10:00',
          copy: { category: 'scheduledFocusReminder' },
          link: '/',
          requested: true,
        }),
      );
      for (let i = 0; i < 3; i += 1) await notifications.enqueue(t.prisma, notice(ana));

      expect(await notifications.dispatchDue(at('2026-11-02T10:00:00Z'))).toMatchObject({
        sent: 3,
        skipped: 1,
      });
      expect((await outbox()).map((row) => row.reason)).toEqual([null, null, null, 'daily_limit']);

      // A new local day starts a new count.
      await notifications.enqueue(
        t.prisma,
        notice(ana, {
          notBefore: at('2026-11-03T10:00:00Z'),
          expiresAt: at('2026-11-04T10:00:00Z'),
        }),
      );
      await notifications.dispatchDue(at('2026-11-03T10:00:00Z'));
      expect(t.push.messages).toHaveLength(4);
    });

    it('forgets devices Expo no longer knows, from tickets and from receipts', async () => {
      const ana = await person();
      await device(ana, 'ExponentPushToken[gone]', 'android').expect(200);
      await device(ana, 'ExponentPushToken[later]', 'android').expect(200);
      t.push.failWith('ExponentPushToken[gone]', 'DeviceNotRegistered');
      t.push.receiptErrorFor('ExponentPushToken[later]', 'DeviceNotRegistered');

      await notifications.enqueue(t.prisma, notice(ana));
      await notifications.dispatchDue(at('2026-11-02T10:00:00Z'));
      expect((await outbox())[0]!.status).toBe('sent');
      expect((await t.prisma.pushDevice.findMany()).map((d) => d.token).sort()).toEqual([
        'ExponentPushToken[ana]',
        'ExponentPushToken[later]',
      ]);

      // Receipts are read fifteen minutes later.
      await jobs.runDue(at('2026-11-02T10:14:00Z'));
      expect(await t.prisma.pushDevice.count()).toBe(2);
      await jobs.runDue(at('2026-11-02T10:15:00Z'));
      expect((await t.prisma.pushDevice.findMany()).map((d) => d.token)).toEqual([
        'ExponentPushToken[ana]',
      ]);
    });

    it('marks a notification failed when no device accepts it', async () => {
      const ana = await person();
      t.push.failWith('ExponentPushToken[ana]', 'MessageRateExceeded');
      await notifications.enqueue(t.prisma, notice(ana));
      expect(await notifications.dispatchDue(at('2026-11-02T10:00:00Z'))).toMatchObject({
        failed: 1,
      });
      expect((await outbox())[0]).toMatchObject({
        status: 'failed',
        reason: 'MessageRateExceeded',
      });
      // A failed send is not counted against the daily limit, and the device is kept.
      expect(await t.prisma.pushDevice.count()).toBe(1);
    });

    it('dispatches each notification once when several workers run together', async () => {
      const ana = await person();
      for (let i = 0; i < 2; i += 1) await notifications.enqueue(t.prisma, notice(ana));
      await Promise.all([1, 2, 3].map(() => notifications.dispatchDue(at('2026-11-02T10:00:00Z'))));
      expect(t.push.messages).toHaveLength(2);
    });
  });

  it('keeps a person’s notifications and devices only as long as the account', async () => {
    const ana = await person();
    await notifications.enqueue(t.prisma, notice(ana));
    await t.prisma.user.delete({ where: { id: ana.userId } });
    expect(await t.prisma.pushDevice.count()).toBe(0);
    expect(await t.prisma.notificationOutbox.count()).toBe(0);
  });

  it('reads the limits from the configuration', async () => {
    const config = await t.app.get(NotificationsService).limits();
    expect(config).toEqual({
      maxUnrequestedPerDay: 2,
      informationalHours: { start: 9, end: 21 },
      focusLeaseGraceMinutes: 30,
    });
  });
});
