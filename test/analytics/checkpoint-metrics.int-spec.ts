import { randomUUID } from 'node:crypto';

import { CheckpointMetricsService } from '../../src/analytics/checkpoint-metrics.service.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * CR.2 checkpoint metrics over PostgreSQL: active days from app opens and counted sessions, a
 * return after a gap, the second-month return after a real archive (closed lazily by the API),
 * and a fixed number of statements whatever the cohort's size.
 */

const t = new ConsistencyHarness('2026-09-03T10:00:00.000Z', { countQueries: true });
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

const open = (user: User, localDate: string, name = 'app_opened') =>
  t
    .http()
    .post('/me/analytics/events')
    .set(user.auth)
    .send({
      events: [
        {
          id: randomUUID(),
          name,
          occurredAt: `${localDate}T09:00:00.000Z`,
          localDate,
          platform: 'ios',
          appVersion: '0.1.0',
        },
      ],
    })
    .expect(202);

describe('checkpoint metrics (CR.2, HTTP + PostgreSQL)', () => {
  let metrics: CheckpointMetricsService;
  beforeAll(async () => {
    await t.start();
    metrics = t.app.get(CheckpointMetricsService);
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-09-03T10:00:00.000Z');
    await t.activateConfig();
  });

  it('derives a tester’s month, gap return, and second-month return from stored truth', async () => {
    const ada = await t.signUp('ada@example.com', 'UTC', '2026-09-03T08:00:00.000Z');
    // September: opened on the 3rd, focused on the 3rd and 4th, then quiet until the 12th.
    await open(ada, '2026-09-03');
    await t.setNow('2026-09-03T12:00:00.000Z');
    await t.submit(ada, '2026-09-03T10:00:00.000Z', 30).expect(201);
    await t.setNow('2026-09-04T12:00:00.000Z');
    await t.submit(ada, '2026-09-04T10:00:00.000Z', 30).expect(201);
    await t.setNow('2026-09-12T12:00:00.000Z');
    await open(ada, '2026-09-12', 'app_foregrounded');
    // A discarded session is not activity.
    await t.submit(ada, '2026-09-12T10:00:00.000Z', 2).expect(201);
    // October: September closes on the first read, and Ada is back.
    await t.setNow('2026-10-02T12:00:00.000Z');
    await t.http().get('/me/home').set(ada.auth).expect(200);
    await open(ada, '2026-10-02');

    const m = await metrics.forUser(ada.userId);
    expect(m).toMatchObject({
      joinedOn: '2026-09-03',
      months: [
        { year: 2026, month: 9, activeDays: 3, focusDays: 2 },
        { year: 2026, month: 10, activeDays: 1, focusDays: 0 },
      ],
      activeDays: 4,
      gapReturns: 2,
      firstArchive: { year: 2026, month: 9 },
      secondMonthReturn: true,
      lastActiveOn: '2026-10-02',
      daysSinceLastActive: 0,
    });
    expect(await metrics.forUser(randomUUID())).toBeNull();

    // October grows and is archived in November: the first archive stays September.
    await t.setNow('2026-10-02T12:30:00.000Z');
    await t.submit(ada, '2026-10-02T12:00:00.000Z', 25).expect(201);
    await t.setNow('2026-11-02T12:00:00.000Z');
    await t.http().get('/me/home').set(ada.auth).expect(200);
    expect(await metrics.forUser(ada.userId)).toMatchObject({
      firstArchive: { year: 2026, month: 9 },
      secondMonthReturn: true,
      daysSinceLastActive: 31,
    });
  });

  it('reads join dates and today in the user’s own time zone', async () => {
    // 12:00 UTC on September 2 is already September 3 in Kiritimati (UTC+14).
    const kiri = await t.signUp(
      'kiri@example.com',
      'Pacific/Kiritimati',
      '2026-09-02T12:00:00.000Z',
    );
    await t.setNow('2026-09-02T12:00:00.000Z');
    await t
      .http()
      .post('/me/analytics/events')
      .set(kiri.auth)
      .send({
        events: [
          {
            id: randomUUID(),
            name: 'app_opened',
            occurredAt: '2026-09-02T11:59:00.000Z',
            localDate: '2026-09-03',
            platform: 'ios',
            appVersion: '0.1.0',
          },
        ],
      })
      .expect(202);
    expect(await metrics.forUser(kiri.userId)).toMatchObject({
      joinedOn: '2026-09-03',
      lastActiveOn: '2026-09-03',
      daysSinceLastActive: 0,
    });
    expect((await metrics.cohort('2026-09-02', '2026-09-02')).cohort.users).toBe(1);
  });

  it('reads a cohort by join date with the same statements for 1 or 12 testers', async () => {
    const first = await t.signUp('t0@example.com', 'UTC', '2026-09-03T08:00:00.000Z');
    await open(first, '2026-09-03');
    const one = await t.queries.during(() => metrics.cohort('2026-09-03', '2026-09-03'));
    for (let i = 1; i < 12; i += 1) {
      const user = await t.signUp(`t${i}@example.com`, 'UTC', '2026-09-03T08:00:00.000Z');
      await open(user, '2026-09-03');
    }
    const twelve = await t.queries.during(() => metrics.cohort('2026-09-03', '2026-09-03'));
    expect(twelve).toBe(one);

    const report = await metrics.cohort('2026-09-03', '2026-09-03');
    expect(report.cohort).toMatchObject({ users: 12, multiDayFirstMonth: 0 });
    expect(report.users).toHaveLength(12);
    // Outside the join range: nobody.
    expect((await metrics.cohort('2026-08-01', '2026-08-31')).cohort.users).toBe(0);
  });
});
