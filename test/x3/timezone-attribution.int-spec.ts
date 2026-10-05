import { ConsistencyHarness } from '../support/consistency-harness.js';
import { allHistory, get, MIN, sid, summarize, type X3User } from './x3-support.js';

/**
 * X3: time zones end to end over HTTP. Month attribution is frozen per month context; local
 * dates come from the month's time zone; weeks run Monday to Sunday; Insights months follow
 * attribution while day cells follow local dates. New York has DST, Ho Chi Minh City has none.
 */

const NY = 'America/New_York';
const HCM = 'Asia/Ho_Chi_Minh';
const t = new ConsistencyHarness('2026-10-20T12:00:00.000Z');

interface SessionBody {
  id: string;
  localDate: string;
  year: number;
  month: number;
  counted: boolean;
  growth: { monthClosed: boolean } | null;
  [field: string]: unknown;
}

describe('X3 time zones and month attribution (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-20T12:00:00.000Z');
    await t.activateConfig();
  });

  const submitted = async (user: X3User, startedAt: string, minutes: number, id: string) =>
    (await t.submit(user, startedAt, minutes, id).expect(201)).body as SessionBody;

  it('repairs a missing time zone once and accepts the exact same queued submissions', async () => {
    const user = await t.signUp('offline@example.com', null);
    // Two sessions queued on the device, as raw JSON: the client never changes them.
    const queued = [
      { id: sid(1), startedAt: '2026-10-18T13:00:00.000Z', minutes: 30 },
      { id: sid(2), startedAt: '2026-10-19T13:00:00.000Z', minutes: 25 },
    ].map(({ id, startedAt, minutes }) => ({
      id,
      raw: JSON.stringify({
        topicId: user.topicId,
        startedAt,
        endedAt: new Date(Date.parse(startedAt) + minutes * MIN).toISOString(),
        plannedMinutes: minutes,
        pauseIntervals: [],
      }),
    }));
    const send = (q: (typeof queued)[number]) =>
      t
        .http()
        .put(`/me/sessions/${q.id}`)
        .set(user.auth)
        .set('Content-Type', 'application/json')
        .send(q.raw);

    for (const q of queued) {
      const res = await send(q).expect(422);
      expect((res.body as { code: string }).code).toBe('timezone_required');
    }
    expect(await t.prisma.focusSession.count()).toBe(0);
    expect(await t.prisma.monthAttributionContext.count()).toBe(0);

    // One repair for every blocked session, then the same bytes again.
    await t.http().patch('/me/profile').set(user.auth).send({ timezone: NY }).expect(200);
    const bodies: SessionBody[] = [];
    for (const q of queued) bodies.push((await send(q).expect(201)).body as SessionBody);
    for (const [i, q] of queued.entries()) {
      const raw = JSON.parse(q.raw) as Record<string, unknown>;
      expect(bodies[i]).toMatchObject({
        id: q.id,
        topicId: raw['topicId'],
        startedAt: raw['startedAt'],
        plannedMinutes: raw['plannedMinutes'],
        year: 2026,
        month: 10,
        counted: true,
      });
      // A replay of the same bytes is the stored answer.
      expect((await send(q).expect(200)).body).toEqual(bodies[i]);
    }
    expect(bodies.map((b) => b.localDate)).toEqual(['2026-10-18', '2026-10-19']);
    expect(await t.prisma.monthAttributionContext.count()).toBe(1);
  });

  it('New York over the DST change: month, local date, Monday week, and closure agree', async () => {
    const user = await t.signUp('ny@example.com', NY);
    // 23:30 EDT on Saturday 31 October: already 1 November in UTC.
    await t.setNow('2026-11-01T05:00:00.000Z');
    const october = await submitted(user, '2026-11-01T03:30:00.000Z', 25, sid(1));
    expect(october).toMatchObject({ localDate: '2026-10-31', year: 2026, month: 10 });
    // 01:30 EST on Sunday 1 November, the second 01:30 of the night (clocks went back at 02:00).
    await t.setNow('2026-11-01T06:55:00.000Z');
    const november = await submitted(user, '2026-11-01T06:30:00.000Z', 20, sid(2));
    expect(november).toMatchObject({ localDate: '2026-11-01', year: 2026, month: 11 });

    const contexts = await t.prisma.monthAttributionContext.findMany({
      where: { userId: user.userId },
      orderBy: { startsAt: 'asc' },
    });
    // October ends at midnight EDT (04:00Z); November ends at midnight EST (05:00Z).
    expect(contexts.map((c) => [c.month, c.endsAt.toISOString()])).toEqual([
      [10, '2026-11-01T04:00:00.000Z'],
      [11, '2026-12-01T05:00:00.000Z'],
    ]);

    // Insights: the week (Monday 26 October to Sunday 1 November) holds both; each month one.
    const week = await get<{ summary: { focusedMilliseconds: number; sessionCount: number } }>(
      t,
      user,
      '/me/insights/week?weekStart=2026-10-26',
    );
    expect(week.summary).toMatchObject({ focusedMilliseconds: 45 * MIN, sessionCount: 2 });
    const oct = await get<{ summary: { sessionCount: number } }>(
      t,
      user,
      '/me/insights/month?year=2026&month=10',
    );
    const nov = await get<{ summary: { sessionCount: number } }>(
      t,
      user,
      '/me/insights/month?year=2026&month=11',
    );
    expect([oct.summary.sessionCount, nov.summary.sessionCount]).toEqual([1, 1]);
    const heatmap = await get<{ days: { date: string; focusedMilliseconds: number }[] }>(
      t,
      user,
      '/me/insights/heatmap?from=2026-10-30&to=2026-11-01',
    );
    expect(heatmap.days.map((d) => [d.date, d.focusedMilliseconds / MIN])).toEqual([
      ['2026-10-30', 0],
      ['2026-10-31', 25],
      ['2026-11-01', 20],
    ]);

    // October closes at its own end plus the grace period: 04:00Z + 180 minutes.
    await t.setNow('2026-11-01T06:59:00.000Z');
    await get(t, user, '/me/home');
    expect((await get<{ kind: string }>(t, user, '/me/trees/2026/10')).kind).toBe('growing');
    await t.setNow('2026-11-01T07:01:00.000Z');
    const home = await get<{ pendingCeremony: unknown; today: string }>(t, user, '/me/home');
    expect(home).toMatchObject({ today: '2026-11-01', pendingCeremony: { year: 2026, month: 10 } });
    expect((await get<{ kind: string }>(t, user, '/me/trees/2026/10')).kind).toBe('archived');
  });

  it('Ho Chi Minh City over the new year: no DST, a week spanning two years', async () => {
    const user = await t.signUp('hcm@example.com', HCM);
    await t.setNow('2026-12-31T18:30:00.000Z');
    // 23:00 on 31 December and 00:30 on 1 January, local time (UTC+7, all year).
    const dec = await submitted(user, '2026-12-31T16:00:00.000Z', 30, sid(1));
    const jan = await submitted(user, '2026-12-31T17:30:00.000Z', 40, sid(2));
    expect(dec).toMatchObject({ localDate: '2026-12-31', year: 2026, month: 12 });
    expect(jan).toMatchObject({ localDate: '2027-01-01', year: 2027, month: 1 });

    const week = await get<{
      period: { from: string; to: string };
      summary: { focusedMilliseconds: number };
    }>(t, user, '/me/insights/week?weekStart=2026-12-28');
    expect(week.period).toMatchObject({ from: '2026-12-28', to: '2027-01-03' });
    expect(week.summary.focusedMilliseconds).toBe(70 * MIN);
    const history = summarize(await allHistory(t, user, 'week=2026-12-28'));
    expect(history.focusedMilliseconds).toBe(70 * MIN);

    // December closes at 17:00Z + grace; January grows in the new year.
    await t.setNow('2026-12-31T20:01:00.000Z');
    const home = await get<{ tree: { year: number; month: number }; pendingCeremony: unknown }>(
      t,
      user,
      '/me/home',
    );
    expect(home.tree).toMatchObject({ year: 2027, month: 1 });
    expect(home.pendingCeremony).toEqual({ year: 2026, month: 12 });
    const forest = await get<{ items: { kind: string; year: number; month: number }[] }>(
      t,
      user,
      '/me/forest',
    );
    expect(forest.items.slice(0, 2).map((i) => [i.year, i.month, i.kind])).toEqual([
      [2027, 1, 'growing'],
      [2026, 12, 'archived'],
    ]);
    // A week record keys by its Monday, across the year.
    const records = await get<{ records: { kind: string; value: number; achievedOn: string }[] }>(
      t,
      user,
      '/me/insights/records',
    );
    expect(records.records.find((r) => r.kind === 'most_focused_week')).toMatchObject({
      value: 70,
      achievedOn: '2026-12-28',
    });
  });

  it('a profile time zone change never moves a month: local date and attributed month can differ', async () => {
    const user = await t.signUp('traveller@example.com', HCM);
    await t.setNow('2026-09-02T03:00:00.000Z');
    await submitted(user, '2026-09-02T02:00:00.000Z', 30, sid(1));
    await t.http().patch('/me/profile').set(user.auth).send({ timezone: NY }).expect(200);

    // After September ended in HCM (17:00Z on 30 September), still 30 September in New York.
    await t.setNow('2026-09-30T21:00:00.000Z');
    const session = await submitted(user, '2026-09-30T20:00:00.000Z', 30, sid(2));
    expect(session).toMatchObject({ localDate: '2026-09-30', year: 2026, month: 10 });
    const september = await t.prisma.monthAttributionContext.findFirst({
      where: { userId: user.userId, month: 9 },
    });
    expect(september?.timezone).toBe(HCM);

    // History shows it at once, and so does Insights (X3.G): October is a month the server
    // attributed sessions to, even though the user's own date is still 30 September.
    expect((await allHistory(t, user, 'month=2026-10')).map((r) => r.id)).toEqual([sid(2)]);
    const contextsBefore = await t.prisma.monthAttributionContext.findMany({
      where: { userId: user.userId },
      orderBy: { startsAt: 'asc' },
    });
    const early = await get<{
      period: { year: number; month: number };
      summary: { focusedMilliseconds: number; sessionCount: number; activeDays: number };
      days: { date: string }[];
    }>(t, user, '/me/insights/month?year=2026&month=10');
    expect(early.period).toMatchObject({ year: 2026, month: 10 });
    expect(early.summary).toMatchObject({
      focusedMilliseconds: 30 * MIN,
      sessionCount: 1,
      activeDays: 1,
    });
    // September keeps only its own session, by attribution.
    const sepEarly = await get<{ summary: { sessionCount: number } }>(
      t,
      user,
      '/me/insights/month?year=2026&month=9',
    );
    expect(sepEarly.summary.sessionCount).toBe(1);
    // The local-date heatmap still puts the session on 30 September.
    const heatmapEarly = await get<{ days: { date: string; sessionCount: number }[] }>(
      t,
      user,
      '/me/insights/heatmap?from=2026-09-30&to=2026-09-30',
    );
    expect(heatmapEarly.days).toEqual([
      expect.objectContaining({ date: '2026-09-30', sessionCount: 1 }),
    ]);
    // Reading Insights creates, moves, or rewrites no month context.
    expect(
      await t.prisma.monthAttributionContext.findMany({
        where: { userId: user.userId },
        orderBy: { startsAt: 'asc' },
      }),
    ).toEqual(contextsBefore);
    expect(contextsBefore.map((c) => [c.month, c.timezone])).toEqual([
      [9, HCM],
      [10, NY],
    ]);
    // A month the server never attributed anything to is still not open.
    await get(t, user, '/me/insights/month?year=2026&month=11', 404);
    await get(t, user, '/me/insights/month?year=2027&month=3', 404);
    // Another user, still in September, gets nothing from this user's October.
    const other = await t.signUp('other@example.com', NY);
    await get(t, other, '/me/insights/month?year=2026&month=10', 404);
    await t.setNow('2026-10-01T05:00:00.000Z');

    // Insights' month follows attribution; History's month filter too; the day follows the date.
    const oct = await get<{ summary: { sessionCount: number } }>(
      t,
      user,
      '/me/insights/month?year=2026&month=10',
    );
    const sep = await get<{ summary: { sessionCount: number } }>(
      t,
      user,
      '/me/insights/month?year=2026&month=9',
    );
    expect([sep.summary.sessionCount, oct.summary.sessionCount]).toEqual([1, 1]);
    expect((await allHistory(t, user, 'month=2026-10')).map((r) => r.id)).toEqual([sid(2)]);
    const heatmap = await get<{ days: { date: string; sessionCount: number }[] }>(
      t,
      user,
      '/me/insights/heatmap?from=2026-09-30&to=2026-09-30',
    );
    expect(heatmap.days).toEqual([
      expect.objectContaining({ date: '2026-09-30', sessionCount: 1 }),
    ]);
  });

  it('keeps the month query boundary for months without attribution: past quiet ones open, future ones not', async () => {
    const user = await t.signUp('quiet@example.com', 'UTC', '2026-07-01T00:00:00.000Z');
    await t.setNow('2026-09-15T12:00:00.000Z');
    await submitted(user, '2026-09-15T08:00:00.000Z', 30, sid(1));
    // A past month with nothing in it answers, empty, as before.
    const august = await get<{ summary: { sessionCount: number } }>(
      t,
      user,
      '/me/insights/month?year=2026&month=8',
    );
    expect(august.summary.sessionCount).toBe(0);
    // The current month answers; the next one has not started and has no context.
    await get(t, user, '/me/insights/month?year=2026&month=9');
    await get(t, user, '/me/insights/month?year=2026&month=10', 404);
    expect(await t.prisma.monthAttributionContext.count({ where: { userId: user.userId } })).toBe(
      1,
    );
  });
});
