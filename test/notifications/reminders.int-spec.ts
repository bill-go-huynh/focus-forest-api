import { JobsService } from '../../src/jobs/jobs.service.js';
import { NotificationsService } from '../../src/notifications/notifications.service.js';
import { RemindersService } from '../../src/notifications/reminders.service.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A6.2 reminders (spec §18; docs/02 Notifications; docs/11 Notification control): the daily goal,
 * scheduled focus, and streak reminders at the time each person chose, in their time zone, at
 * most once a day each, and only while they still make sense. They are invitations: nothing is
 * sent once the goal is met, on a rest day, or when there is no streak to keep.
 */

const t = new ConsistencyHarness('2026-11-02T07:00:00.000Z');
const at = (iso: string) => new Date(iso);

describe('reminders (A6.2)', () => {
  let reminders: RemindersService;
  let notifications: NotificationsService;
  let jobs: JobsService;

  beforeAll(async () => {
    await t.start();
    reminders = t.app.get(RemindersService);
    notifications = t.app.get(NotificationsService);
    jobs = t.app.get(JobsService);
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    t.push.reset();
    await t.activateConfig();
    await t.setNow('2026-11-02T07:00:00.000Z');
  });

  /** Someone in Ho Chi Minh City (UTC+7) with a device and these reminders at these local times. */
  async function person(
    times: Partial<
      Record<'dailyGoalReminder' | 'scheduledFocusReminder' | 'streakReminder', string>
    >,
    email = 'ana@example.com',
    timeZone: string | null = 'Asia/Ho_Chi_Minh',
  ) {
    const user = await t.signUp(email, timeZone);
    await t
      .http()
      .put(`/me/devices/${encodeURIComponent(`ExponentPushToken[${email.split('@')[0]}]`)}`)
      .set(user.auth)
      .send({ platform: 'ios' })
      .expect(200);
    await t
      .http()
      .patch('/me/preferences')
      .set(user.auth)
      .send({
        notifications: Object.fromEntries(
          Object.entries(times).map(([category, time]) => [category, { enabled: true, time }]),
        ),
      })
      .expect(200);
    return user;
  }

  /** Plans the quarter hour starting at `iso`, then dispatches what is due then. */
  async function runSlot(iso: string) {
    await t.setNow(iso);
    await reminders.plan(at(iso));
    await notifications.dispatchDue(at(iso));
  }

  const sent = () => t.push.messages.map((m) => [m.to, m.data.category, m.title, m.body]);

  it('sends each reminder at the person’s local time, as an invitation to Home', async () => {
    await person({
      dailyGoalReminder: '15:00',
      scheduledFocusReminder: '15:00',
      streakReminder: '20:00',
    });

    await runSlot('2026-11-02T07:45:00.000Z');
    expect(sent()).toEqual([]);

    // 15:00 in Ho Chi Minh City is 08:00 UTC.
    await runSlot('2026-11-02T08:00:00.000Z');
    expect(sent()).toEqual([
      [
        'ExponentPushToken[ana]',
        'dailyGoalReminder',
        'A little focus today?',
        'Your daily goal is 30 minutes. Your tree is ready when you are.',
      ],
      [
        'ExponentPushToken[ana]',
        'scheduledFocusReminder',
        'Time to focus',
        'You planned a focus session for now. Your tree is ready when you are.',
      ],
    ]);
    expect(t.push.messages.every((m) => m.data.link === '/')).toBe(true);
    const rows = await t.prisma.notificationOutbox.findMany({ orderBy: { id: 'asc' } });
    expect(rows.every((row) => row.requested)).toBe(true);
    expect(rows.map((row) => row.dedupeKey)).toEqual([
      'reminder:dailyGoalReminder:2026-11-02:15:00',
      'reminder:scheduledFocusReminder:2026-11-02:15:00',
    ]);
  });

  it('plans a reminder in its own quarter hour only, never earlier or later', async () => {
    // 15:15 local is 08:15 UTC: the quarter starting then holds it, the one before does not.
    await person({ scheduledFocusReminder: '15:15' });
    await t.setNow('2026-11-02T08:00:00.000Z');
    expect(await reminders.plan(at('2026-11-02T08:00:00Z'))).toBe(0);
    // 09:00 local passed hours ago: a later quarter does not plan it after the fact.
    await person({ scheduledFocusReminder: '09:00' }, 'ben@example.com');
    expect(await reminders.plan(at('2026-11-02T08:15:00Z'))).toBe(1);
    expect(
      (await t.prisma.notificationOutbox.findMany()).map((row) => [row.dedupeKey, row.notBefore]),
    ).toEqual([['reminder:scheduledFocusReminder:2026-11-02:15:15', at('2026-11-02T08:15:00Z')]]);
  });

  it('plans a slot only once, and never twice a day after a change of time', async () => {
    const ana = await person({ scheduledFocusReminder: '15:00' });
    await runSlot('2026-11-02T08:00:00.000Z');
    await runSlot('2026-11-02T08:00:00.000Z');
    expect(sent()).toHaveLength(1);

    // Moved to 18:00 the same day: today's reminder was already sent.
    await t
      .http()
      .patch('/me/preferences')
      .set(ana.auth)
      .send({ notifications: { scheduledFocusReminder: { enabled: true, time: '18:00' } } })
      .expect(200);
    await runSlot('2026-11-02T11:00:00.000Z');
    expect(sent()).toHaveLength(1);
    expect(
      (await t.prisma.notificationOutbox.findMany({ orderBy: { id: 'asc' } }))[1],
    ).toMatchObject({ status: 'skipped', reason: 'not_relevant' });

    // The next day it comes at 18:00.
    await runSlot('2026-11-03T08:00:00.000Z');
    expect(sent()).toHaveLength(1);
    await runSlot('2026-11-03T11:00:00.000Z');
    expect(sent()).toHaveLength(2);
  });

  it('drops a reminder planned for a time the person has since changed', async () => {
    const ana = await person({ scheduledFocusReminder: '15:00' });
    await t.setNow('2026-11-02T08:00:00.000Z');
    await reminders.plan(at('2026-11-02T08:00:00.000Z'));
    await t
      .http()
      .patch('/me/preferences')
      .set(ana.auth)
      .send({ notifications: { scheduledFocusReminder: { enabled: true, time: '16:00' } } })
      .expect(200);
    await notifications.dispatchDue(at('2026-11-02T08:00:00.000Z'));
    expect(sent()).toEqual([]);

    await runSlot('2026-11-02T09:00:00.000Z');
    expect(sent()).toHaveLength(1);
  });

  it('says nothing about the daily goal once it is met', async () => {
    const ana = await person({ dailyGoalReminder: '15:00' });
    await t.focus(ana, [['2026-11-02', 30]]);
    await runSlot('2026-11-02T08:00:00.000Z');
    expect(sent()).toEqual([]);
  });

  it('rests on a rest day: no goal or focus reminder', async () => {
    const ana = await person({ dailyGoalReminder: '15:00', scheduledFocusReminder: '15:00' });
    await t.http().put('/me/rest-days/2026-11-02').set(ana.auth).expect(201);
    await runSlot('2026-11-02T08:00:00.000Z');
    expect(sent()).toEqual([]);
  });

  it('invites to keep a streak only when there is one and today has no focus yet', async () => {
    const ana = await person({ streakReminder: '20:00' });
    await t.focus(ana, [
      ['2026-10-30', 25],
      ['2026-10-31', 25],
      ['2026-11-01', 25],
    ]);
    // 20:00 in Ho Chi Minh City is 13:00 UTC.
    await runSlot('2026-11-02T13:00:00.000Z');
    expect(sent()).toEqual([
      [
        'ExponentPushToken[ana]',
        'streakReminder',
        'Your forest is waiting',
        '3 days of steady focus so far. A short session today keeps the rhythm, if it suits you.',
      ],
    ]);

    // Focus today: nothing tomorrow evening asks for more than that.
    await t.focus(ana, [['2026-11-03', 25]]);
    await runSlot('2026-11-03T13:00:00.000Z');
    expect(sent()).toHaveLength(1);
  });

  it('never mentions a streak of zero', async () => {
    await person({ streakReminder: '20:00' });
    await runSlot('2026-11-02T13:00:00.000Z');
    expect(sent()).toEqual([]);
    expect(await t.prisma.notificationOutbox.count()).toBe(0);
  });

  it('plans nothing that is off, has no time, or has no time zone', async () => {
    const ana = await person({ scheduledFocusReminder: '15:00' }, 'ana@example.com');
    await t
      .http()
      .patch('/me/preferences')
      .set(ana.auth)
      .send({ notifications: { scheduledFocusReminder: { enabled: false } } })
      .expect(200);
    await person({}, 'ben@example.com');
    await t.prisma.notificationPreference.create({
      data: {
        userId: (await t.prisma.user.findFirstOrThrow({ where: { email: 'ben@example.com' } })).id,
        category: 'scheduledFocusReminder',
        enabled: true,
        time: null,
      },
    });
    await person({ scheduledFocusReminder: '08:00' }, 'cam@example.com', null);

    for (const slot of ['2026-11-02T08:00:00.000Z', '2026-11-02T00:00:00.000Z']) {
      await runSlot(slot);
    }
    expect(await t.prisma.notificationOutbox.count()).toBe(0);
  });

  it('follows each person’s own time zone, across daylight saving changes', async () => {
    await person({ scheduledFocusReminder: '09:00' }, 'bea@example.com', 'Europe/Berlin');
    await person({ scheduledFocusReminder: '09:00' }, 'kai@example.com', 'America/New_York');

    // Berlin is UTC+1 in November: 09:00 is 08:00 UTC. New York (UTC−5) waits until 14:00 UTC.
    await runSlot('2026-11-02T08:00:00.000Z');
    expect(sent().map(([to]) => to)).toEqual(['ExponentPushToken[bea]']);
    await runSlot('2026-11-02T14:00:00.000Z');
    expect(sent().map(([to]) => to)).toEqual(['ExponentPushToken[bea]', 'ExponentPushToken[kai]']);

    // On 28 March 2027 Berlin moves to UTC+2: 09:00 is 07:00 UTC.
    await runSlot('2027-03-28T07:00:00.000Z');
    expect(sent().map(([to]) => to)).toHaveLength(3);
  });

  it('plans every quarter hour through a job that schedules the next one', async () => {
    await person({ scheduledFocusReminder: '15:10' });
    await reminders.start(at('2026-11-02T08:02:00Z'));
    await reminders.start(at('2026-11-02T08:02:00Z'));
    expect(
      (await t.prisma.job.findMany()).map((job) => [job.kind, job.runAt, job.dedupeKey]),
    ).toEqual([
      ['reminders.plan', at('2026-11-02T08:00:00Z'), 'reminders.plan:2026-11-02T08:00:00.000Z'],
    ]);

    await t.setNow('2026-11-02T08:02:00.000Z');
    await jobs.runDue(at('2026-11-02T08:02:00Z'));
    // 15:10 local is 08:10 UTC, inside the 08:00 quarter.
    expect(await t.prisma.notificationOutbox.count()).toBe(1);
    expect(
      (await t.prisma.job.findMany({ where: { completedAt: null } })).map((job) => job.runAt),
    ).toEqual([at('2026-11-02T08:15:00Z')]);
  });

  it('lets a reminder expire if focus or a pause holds it back too long', async () => {
    const ana = await person({ scheduledFocusReminder: '15:00' });
    await t.setNow('2026-11-02T08:00:00.000Z');
    await t
      .http()
      .put('/me/focus/active')
      .set(ana.auth)
      .send({ endsAt: '2026-11-02T10:00:00.000Z' })
      .expect(200);
    await reminders.plan(at('2026-11-02T08:00:00Z'));
    await notifications.dispatchDue(at('2026-11-02T08:00:00Z'));
    await t.setNow('2026-11-02T10:30:00.000Z');
    await notifications.dispatchDue(at('2026-11-02T10:30:00Z'));
    expect(sent()).toEqual([]);
    expect((await t.prisma.notificationOutbox.findFirstOrThrow()).reason).toBe('expired');
  });

  it('never reaches someone suspended', async () => {
    const ana = await person({ scheduledFocusReminder: '15:00' });
    await t.prisma.user.update({ where: { id: ana.userId }, data: { status: 'suspended' } });
    await reminders.plan(at('2026-11-02T08:00:00Z'));
    expect(await t.prisma.notificationOutbox.count()).toBe(0);
  });
});
