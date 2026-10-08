import { randomUUID } from 'node:crypto';

import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * CR.1 product analytics ingest over HTTP + PostgreSQL: the signed-in user's own events, stored
 * once by their id, only allowlisted names and integer props, nothing when sharing is off,
 * deleted with the user, and never readable through a product endpoint.
 */

const t = new ConsistencyHarness('2026-10-08T12:00:00.000Z');
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

const event = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  name: 'app_opened',
  occurredAt: '2026-10-08T11:58:00.000Z',
  localDate: '2026-10-08',
  platform: 'android',
  appVersion: '0.1.0',
  ...overrides,
});

const send = (user: User, events: unknown[], status = 202) =>
  t.http().post('/me/analytics/events').set(user.auth).send({ events }).expect(status);

const stored = (userId: string) =>
  t.prisma.analyticsEvent.findMany({ where: { userId }, orderBy: { occurredAt: 'asc' } });

describe('product analytics ingest (CR.1, HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-08T12:00:00.000Z');
    await t.activateConfig();
  });

  it('stores the user’s events once, by their id, with only allowlisted props', async () => {
    const ada = await t.signUp('ada@example.com', 'UTC');
    const opened = event();
    const started = event({
      name: 'focus_started',
      occurredAt: '2026-10-08T11:59:00.000Z',
      props: { plannedMinutes: 25, topicName: 'Thesis' },
    });
    expect((await send(ada, [opened, started])).body).toEqual({ accepted: 2, ignored: 0 });
    // A retried batch: the same ids are accepted again and stored once.
    expect((await send(ada, [opened, started])).body).toEqual({ accepted: 2, ignored: 0 });

    const rows = await stored(ada.userId);
    expect(rows.map((row) => [row.id, row.name, row.props])).toEqual([
      [opened.id, 'app_opened', {}],
      [started.id, 'focus_started', { plannedMinutes: 25 }],
    ]);
    expect(rows[0]).toMatchObject({
      platform: 'android',
      appVersion: '0.1.0',
      localDate: new Date('2026-10-08T00:00:00.000Z'),
      receivedAt: new Date('2026-10-08T12:00:00.000Z'),
    });
  });

  it('ignores unknown names and events outside the window, and says how many', async () => {
    const ada = await t.signUp('ada@example.com', 'UTC');
    const res = await send(ada, [
      event(),
      event({ name: 'screen_viewed' }),
      event({ occurredAt: '2026-08-01T00:00:00.000Z', localDate: '2026-08-01' }),
    ]);
    expect(res.body).toEqual({ accepted: 1, ignored: 2 });
    expect(await stored(ada.userId)).toHaveLength(1);
  });

  it('stores nothing while the user does not share usage data', async () => {
    const ada = await t.signUp('ada@example.com', 'UTC');
    const prefs = await t.http().get('/me/preferences').set(ada.auth).expect(200);
    expect(prefs.body).toMatchObject({ shareUsageData: true });
    await t
      .http()
      .patch('/me/preferences')
      .set(ada.auth)
      .send({ shareUsageData: false })
      .expect(200);
    expect((await send(ada, [event(), event()])).body).toEqual({ accepted: 0, ignored: 2 });
    expect(await stored(ada.userId)).toEqual([]);
  });

  it('refuses a malformed batch, and requires a signed-in user', async () => {
    const ada = await t.signUp('ada@example.com', 'UTC');
    await send(
      ada,
      Array.from({ length: 51 }, () => event()),
      400,
    );
    await send(ada, [event({ id: 'not-a-uuid' })], 400);
    await send(ada, [event({ appVersion: 'x'.repeat(33) })], 400);
    await t
      .http()
      .post('/me/analytics/events')
      .send({ events: [event()] })
      .expect(401);
    expect(await stored(ada.userId)).toEqual([]);
  });

  it('keeps users apart, and an id another user sent is never overwritten', async () => {
    const ada = await t.signUp('ada@example.com', 'UTC');
    const bob = await t.signUp('bob@example.com', 'UTC');
    const shared = event();
    await send(ada, [shared]);
    await send(bob, [{ ...shared, name: 'forest_opened' }]);
    expect((await stored(ada.userId)).map((row) => row.name)).toEqual(['app_opened']);
    expect(await stored(bob.userId)).toEqual([]);
  });

  it('deletes a user’s events with the user', async () => {
    const ada = await t.signUp('ada@example.com', 'UTC');
    await send(ada, [event(), event()]);
    await t.prisma.user.delete({ where: { id: ada.userId } });
    expect(await t.prisma.analyticsEvent.count()).toBe(0);
  });

  it('lets the database refuse a name outside the allowlist', async () => {
    const ada = await t.signUp('ada@example.com', 'UTC');
    await expect(
      t.prisma.analyticsEvent.create({
        data: {
          id: randomUUID(),
          userId: ada.userId,
          name: 'note_written',
          occurredAt: new Date(),
          receivedAt: new Date(),
          localDate: new Date('2026-10-08'),
          platform: 'ios',
          appVersion: '0.1.0',
        },
      }),
    ).rejects.toThrow(/analytics_events_name_known/);
  });

  it('is never readable through the app: there is no read route', async () => {
    const ada = await t.signUp('ada@example.com', 'UTC');
    await t.http().get('/me/analytics/events').set(ada.auth).expect(404);
  });
});
