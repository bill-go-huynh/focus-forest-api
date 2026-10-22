import { randomUUID } from 'node:crypto';

import { ConsistencyHarness, dateRange } from '../support/consistency-harness.js';

// Wednesday 7 October 2026, 20:00 UTC.
const NOW = '2026-10-07T20:00:00.000Z';
const t = new ConsistencyHarness(NOW, { countQueries: true });
const MIN = 60_000;

type User = Awaited<ReturnType<typeof t.signUp>>;

interface DayCell {
  date: string;
  focusedMilliseconds: number;
  sessionCount: number;
  active: boolean;
  rest: boolean;
  dailyGoal: 'met' | 'not_met' | 'pending' | 'none';
  dailyGoalMinutes: number | null;
}

interface TopicInsight {
  topicId: string;
  name: string;
  status: string;
  focusedMilliseconds: number;
  sessionCount: number;
  share: number;
  lastUsedAt: string;
}

interface Summary {
  focusedMilliseconds: number;
  sessionCount: number;
  activeDays: number;
  averageFocusedMillisecondsPerActiveDay: number | null;
}

interface PersonalRecordBody {
  kind: string;
  value: number;
  unit: string;
  achievedOn: string;
}

interface WeekInsights {
  period: { kind: 'week'; from: string; to: string; current: boolean };
  summary: Summary;
  days: DayCell[];
  topics: TopicInsight[];
  longestSession: { sessionId: string; focusedMilliseconds: number; localDate: string } | null;
  goals: {
    daily: { completed: number; eligible: number };
    weekly: { current: number; target: number; completed: boolean } | null;
  };
  restDays: number;
  streak: { current: number; longest: number; longestInPeriod: number };
  newRecords: PersonalRecordBody[];
}

interface MonthInsights extends Omit<WeekInsights, 'period' | 'goals'> {
  period: {
    kind: 'month';
    year: number;
    month: number;
    from: string;
    to: string;
    current: boolean;
    archived: boolean;
  };
  topTopic: TopicInsight | null;
  mostProductiveDay: { date: string; focusedMinutes: number } | null;
  mostProductiveWeek: { weekStart: string; focusedMinutes: number } | null;
  goals: {
    daily: { completed: number; eligible: number };
    weekly: { completed: number; eligible: number };
  };
  archivedStats: { focusedMinutes: number; sessionCount: number } | null;
}

describe('insights, records, and lifetime stats (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow(NOW);
    await t.activateConfig();
  });

  const get = async <T = PersonalRecordBody>(user: User, path: string, status = 200) =>
    (await t.http().get(path).set(user.auth).expect(status)).body as T;
  const week = (user: User, weekStart = '2026-10-05') =>
    get<WeekInsights>(user, `/me/insights/week?weekStart=${weekStart}`);
  const month = (user: User, year = 2026, value = 10) =>
    get<MonthInsights>(user, `/me/insights/month?year=${year}&month=${value}`);
  const records = async (user: User) =>
    (await get<{ records: PersonalRecordBody[] }>(user, '/me/insights/records')).records;
  const submitted = async (user: User, startedAt: string, minutes: number) =>
    (await t.submit(user, startedAt, minutes).expect(201)).body as { id: string };
  const topic = async (user: User, name: string) => {
    const id = randomUUID();
    await t
      .http()
      .put(`/me/topics/${id}`)
      .set(user.auth)
      .send({ name, icon: 'book', color: 'topic.2' })
      .expect(201);
    return { ...user, topicId: id };
  };

  describe('week', () => {
    it('sums one Monday-to-Sunday week from counted sessions only', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-10-04', 500], // Sunday before
        ['2026-10-05', 30],
        ['2026-10-06', 2, 'discarded'],
        ['2026-10-11', 60], // Sunday
        ['2026-10-12', 500], // Monday after
      ]);
      const insights = await week(ada);
      expect(insights.period).toEqual({
        kind: 'week',
        from: '2026-10-05',
        to: '2026-10-11',
        current: true,
      });
      expect(insights.summary).toEqual({
        focusedMilliseconds: 90 * MIN,
        sessionCount: 2,
        activeDays: 2,
        averageFocusedMillisecondsPerActiveDay: 45 * MIN,
      });
      expect(insights.days.map((cell) => [cell.date, cell.sessionCount])).toEqual([
        ['2026-10-05', 1],
        ['2026-10-06', 0],
        ['2026-10-07', 0],
        ['2026-10-08', 0],
        ['2026-10-09', 0],
        ['2026-10-10', 0],
        ['2026-10-11', 1],
      ]);
      expect(insights.longestSession).toMatchObject({
        focusedMilliseconds: 60 * MIN,
        localDate: '2026-10-11',
      });
      // The current week defaults to today's.
      expect((await get<WeekInsights>(ada, '/me/insights/week')).period.from).toBe('2026-10-05');
    });

    it('shows rest days, the daily goal of each day, and the weekly goal', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.http().put('/me/goals/daily').set(ada.auth).send({ minutes: 30 }).expect(200);
      await t
        .http()
        .put('/me/goals/weekly')
        .set(ada.auth)
        .send({ type: 'focused_minutes', target: 120 })
        .expect(200);
      await t.http().put('/me/rest-days/2026-10-07').set(ada.auth).expect(201);
      await submitted(ada, '2026-10-07T10:00:00.000Z', 40);

      const insights = await week(ada);
      expect(insights.days[2]).toEqual({
        date: '2026-10-07',
        focusedMilliseconds: 40 * MIN,
        sessionCount: 1,
        active: true,
        rest: true,
        dailyGoal: 'met',
        dailyGoalMinutes: 30,
      });
      expect(insights.days[0]?.dailyGoal).toBe('none'); // before the first daily goal
      expect(insights.days[3]?.dailyGoal).toBe('pending');
      expect(insights.goals).toEqual({
        daily: { completed: 1, eligible: 1 },
        weekly: expect.objectContaining({ current: 40, target: 120, completed: false }) as unknown,
      });
      expect(insights.restDays).toBe(1);
      expect(insights.streak).toEqual({ current: 0, longest: 0, longestInPeriod: 0 });
    });

    it('splits focus by topic, archived topics included, adding up to the total', async () => {
      const ada = await t.signUp('ada@example.com');
      const maths = await topic(ada, 'Maths');
      await submitted(ada, '2026-10-05T08:00:00.000Z', 30);
      await submitted(maths, '2026-10-06T08:00:00.000Z', 60);
      await submitted(maths, '2026-10-07T08:00:00.000Z', 30);
      await t.http().post(`/me/topics/${maths.topicId}/archive`).set(ada.auth).expect(200);

      const insights = await week(ada);
      expect(
        insights.topics.map((entry) => [
          entry.name,
          entry.status,
          entry.focusedMilliseconds,
          entry.sessionCount,
          entry.share,
          entry.lastUsedAt,
        ]),
      ).toEqual([
        ['Maths', 'archived', 90 * MIN, 2, 0.75, '2026-10-07T08:00:00.000Z'],
        ['Reading', 'active', 30 * MIN, 1, 0.25, '2026-10-05T08:00:00.000Z'],
      ]);
      expect(insights.topics.reduce((sum, entry) => sum + entry.focusedMilliseconds, 0)).toBe(
        insights.summary.focusedMilliseconds,
      );
    });

    it('refuses a week that does not start on a Monday', async () => {
      const ada = await t.signUp('ada@example.com');
      await get(ada, '/me/insights/week?weekStart=2026-10-06', 400);
      await get(ada, '/me/insights/week?weekStart=2026-13-01', 400);
      await get(ada, '/me/insights/week?period=week', 400);
    });
  });

  describe('month', () => {
    it('counts late sessions in its numbers while the archive and recap stay as they were', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-10-05', 60],
        ['2026-10-06', 30],
      ]);
      await t.setNow('2026-11-02T10:00:00.000Z');
      const before = await month(ada);
      expect(before.period).toMatchObject({ archived: true, current: false });
      expect(before.summary.focusedMilliseconds).toBe(90 * MIN);
      expect(before.archivedStats).toMatchObject({ focusedMinutes: 90, sessionCount: 2 });
      const recap = await get(ada, '/me/trees/2026/10/recap');
      const lifetimeRecords = await records(ada);

      await submitted(ada, '2026-10-20T10:00:00.000Z', 200); // late
      const after = await month(ada);
      expect(after.summary).toMatchObject({ focusedMilliseconds: 290 * MIN, sessionCount: 3 });
      expect(after.archivedStats).toEqual(before.archivedStats);
      expect(await get(ada, '/me/trees/2026/10/recap')).toEqual(recap);
      // Derived lifetime records follow the late session.
      const day = (list: PersonalRecordBody[]) =>
        list.find((record) => record.kind === 'most_focused_day');
      expect(day(lifetimeRecords)).toMatchObject({ value: 60 });
      expect(day(await records(ada))).toMatchObject({ value: 200, achievedOn: '2026-10-20' });
    });

    it('names its productive day and week, earliest on a tie, and its top topic', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-10-06', 60],
        ['2026-10-14', 60],
      ]);
      const insights = await month(ada);
      expect(insights).toMatchObject({
        period: { kind: 'month', year: 2026, month: 10, from: '2026-10-01', to: '2026-10-31' },
        mostProductiveDay: { date: '2026-10-06', focusedMinutes: 60 },
        mostProductiveWeek: { weekStart: '2026-10-05', focusedMinutes: 60 },
        topTopic: { topicId: ada.topicId, share: 1 },
        archivedStats: null,
      });
      expect(insights.days).toHaveLength(31);
    });

    it('takes its numbers from the attributed month and its days from local dates', async () => {
      // September in Ho Chi Minh City ends on 30 September at 17:00 UTC.
      await t.setNow('2026-09-15T10:00:00.000Z');
      const ada = await t.signUp('ada@example.com', 'Asia/Ho_Chi_Minh');
      await get(ada, '/me/trees/current');
      await t
        .http()
        .patch('/me/profile')
        .set(ada.auth)
        .send({ timezone: 'America/New_York' })
        .expect(200);
      await t.setNow('2026-10-02T10:00:00.000Z');
      // October (New York), on its real local date of 30 September.
      const session = await submitted(ada, '2026-09-30T20:00:00.000Z', 30);

      const october = await month(ada);
      expect(october.summary.sessionCount).toBe(1);
      expect(october.days.find((cell) => cell.date === '2026-09-30')).toBeUndefined();
      const september = await month(ada, 2026, 9);
      expect(september.summary.sessionCount).toBe(0);
      expect(september.days.find((cell) => cell.date === '2026-09-30')).toMatchObject({
        sessionCount: 1,
      });
      expect(session).toBeDefined();
    });

    it('rates daily goals over decided days with a goal, weekly goals by the month of their Monday', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.setNow('2026-10-02T20:00:00.000Z');
      await t.http().put('/me/goals/daily').set(ada.auth).send({ minutes: 30 }).expect(200);
      await t
        .http()
        .put('/me/goals/weekly')
        .set(ada.auth)
        .send({ type: 'session_count', target: 1 })
        .expect(200);
      await t.setNow('2026-10-07T20:00:00.000Z');
      await t.focus(ada, [
        ['2026-09-29', 60],
        ['2026-10-01', 40], // before the first daily goal: not in the rate
        ['2026-10-02', 10],
        ['2026-10-06', 30],
      ]);
      const insights = await month(ada);
      // Daily: 2–6 October decided (6 met); 1 October had no goal; 7 is today and not met.
      expect(insights.goals.daily).toEqual({ completed: 1, eligible: 5 });
      // Weekly: the week of 28 September belongs to September; 5 October is met; 12, 19,
      // 26 October have not ended.
      expect(insights.goals.weekly).toEqual({ completed: 1, eligible: 1 });
    });

    it('refuses months that are not months', async () => {
      const ada = await t.signUp('ada@example.com');
      await get(ada, '/me/insights/month?year=2026&month=13', 400);
      await get(ada, '/me/insights/month?year=26&month=1', 400);
      await get(ada, '/me/insights/month?year=2026&month=11', 404); // not yet
    });
  });

  describe('heatmap', () => {
    it('has a cell for every local date: empty, focus, rest, rest with focus, goal state', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.http().put('/me/goals/daily').set(ada.auth).send({ minutes: 30 }).expect(200);
      await t.http().put('/me/rest-days/2026-10-08').set(ada.auth).expect(201);
      await t.focus(ada, [['2026-10-03', 10]]);
      await t.setNow('2026-10-08T20:00:00.000Z');
      await submitted(ada, '2026-10-07T05:00:00.000Z', 40);
      await submitted(ada, '2026-10-08T05:00:00.000Z', 10);
      const heatmap = await get<{ from: string; to: string; days: DayCell[] }>(
        ada,
        '/me/insights/heatmap?from=2026-10-03&to=2026-10-08',
      );
      expect(
        heatmap.days.map((cell) => [cell.date, cell.sessionCount, cell.rest, cell.dailyGoal]),
      ).toEqual([
        ['2026-10-03', 1, false, 'none'],
        ['2026-10-04', 0, false, 'none'],
        ['2026-10-05', 0, false, 'none'],
        ['2026-10-06', 0, false, 'none'],
        ['2026-10-07', 1, false, 'met'],
        ['2026-10-08', 1, true, 'pending'],
      ]);
    });

    it('uses the session’s stored local date, not its UTC date', async () => {
      await t.setNow('2026-10-07T20:00:00.000Z');
      const ada = await t.signUp('ada@example.com', 'Asia/Ho_Chi_Minh');
      // 20:00 UTC on 5 October is 6 October in Ho Chi Minh City.
      await submitted(ada, '2026-10-05T20:00:00.000Z', 30);
      const heatmap = await get<{ days: DayCell[] }>(
        ada,
        '/me/insights/heatmap?from=2026-10-05&to=2026-10-06',
      );
      expect(heatmap.days.map((cell) => cell.sessionCount)).toEqual([0, 1]);
      // 6 October alone holds it, though it started on 5 October in UTC.
      const sixth = await get<{ days: DayCell[] }>(
        ada,
        '/me/insights/heatmap?from=2026-10-06&to=2026-10-06',
      );
      expect(sixth.days.map((cell) => cell.sessionCount)).toEqual([1]);
    });

    it('defaults to the last 365 days and refuses longer ranges', async () => {
      const ada = await t.signUp('ada@example.com');
      const heatmap = await get<{ from: string; to: string; days: DayCell[] }>(
        ada,
        '/me/insights/heatmap',
      );
      expect(heatmap).toMatchObject({ from: '2025-10-08', to: '2026-10-07' });
      expect(heatmap.days).toHaveLength(365);
      await get(ada, '/me/insights/heatmap?from=2025-01-01&to=2026-10-07', 400);
      await get(ada, '/me/insights/heatmap?from=2026-10-07&to=2026-10-01', 400);
      // A range ending later stops at today.
      expect(
        (await get<{ to: string }>(ada, '/me/insights/heatmap?from=2026-10-01&to=2026-12-01')).to,
      ).toBe('2026-10-07');
    });
  });

  describe('records and lifetime stats', () => {
    it('lists all six records from stored truth', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.setNow('2026-10-01T20:00:00.000Z');
      await t.http().put('/me/goals/daily').set(ada.auth).send({ minutes: 30 }).expect(200);
      await t.setNow(NOW);
      await t.focus(ada, [
        ['2026-09-28', 20],
        ['2026-10-01', 40],
        ['2026-10-02', 50],
        ['2026-10-03', 20],
        ['2026-10-05', 30],
      ]);
      expect(await records(ada)).toEqual([
        { kind: 'most_focused_day', value: 50, unit: 'minutes', achievedOn: '2026-10-02' },
        { kind: 'most_focused_week', value: 130, unit: 'minutes', achievedOn: '2026-09-28' },
        { kind: 'most_focused_month', value: 140, unit: 'minutes', achievedOn: '2026-10-01' },
        { kind: 'longest_streak', value: 3, unit: 'days', achievedOn: '2026-10-03' },
        { kind: 'longest_session', value: 50, unit: 'minutes', achievedOn: '2026-10-02' },
        { kind: 'longest_daily_goal_streak', value: 2, unit: 'days', achievedOn: '2026-10-02' },
      ]);
    });

    it('gives lifetime stats from every counted session, late ones included', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-09-10', 60],
        ['2026-09-11', 2, 'discarded'],
        ['2026-10-06', 30],
        ['2026-10-07', 30],
      ]);
      await t.setNow('2026-11-02T10:00:00.000Z');
      await submitted(ada, '2026-11-02T08:00:00.000Z', 15);
      await submitted(ada, '2026-10-20T08:00:00.000Z', 15); // late
      const stats = await get(ada, '/me/profile/stats');
      expect(stats).toEqual({
        focusedMilliseconds: 150 * MIN,
        sessionCount: 5,
        currentStreak: 1,
        longestStreak: 2,
        archivedTreeCount: 2,
      });
      const forest = await get<{ summary: { treeCount: number; lifetimeFocusedMinutes: number } }>(
        ada,
        '/me/forest',
      );
      expect(forest.summary).toEqual({ treeCount: 2, lifetimeFocusedMinutes: 150 });
    });

    it('keeps each user’s numbers apart', async () => {
      const ada = await t.signUp('ada@example.com');
      const bob = await t.signUp('bob@example.com');
      await t.focus(ada, [['2026-10-06', 60]]);
      expect((await week(bob)).summary.sessionCount).toBe(0);
      expect((await month(bob)).topics).toEqual([]);
      expect(await records(bob)).toEqual([]);
      expect(await get(bob, '/me/profile/stats')).toMatchObject({ focusedMilliseconds: 0 });
    });
  });

  describe('home', () => {
    it('has everything Home shows, this week’s focus included', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-10-04', 100], // the week before
        ['2026-10-05', 30],
      ]);
      await submitted(ada, '2026-10-07T10:00:00.000Z', 20);
      const home = await get<Record<string, unknown>>(ada, '/me/home');
      expect(Object.keys(home).sort()).toEqual([
        'goals',
        'pendingCeremony',
        'recentTopics',
        'rest',
        'streak',
        'today',
        'tree',
        'week',
      ]);
      expect(home['week']).toEqual({
        weekStart: '2026-10-05',
        focusedMilliseconds: 50 * MIN,
        sessionCount: 2,
        activeDays: 2,
      });
    });
  });

  describe('query shape', () => {
    it('answers with as many queries for a year of history as for a week', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [['2026-10-05', 30]]);
      await month(ada); // closes nothing more after this
      const short = {
        week: await t.queries.during(() => week(ada)),
        month: await t.queries.during(() => month(ada)),
        records: await t.queries.during(() => records(ada)),
        heatmap: await t.queries.during(() =>
          get(ada, '/me/insights/heatmap?from=2026-10-01&to=2026-10-07'),
        ),
        stats: await t.queries.during(() => get(ada, '/me/profile/stats')),
      };

      await t.focus(
        ada,
        dateRange('2025-11-01', 300)
          .filter((_, index) => index % 3 === 0)
          .map((date) => [date, 30] as [string, number]),
      );
      await month(ada); // closes the new past months
      const long = {
        week: await t.queries.during(() => week(ada)),
        month: await t.queries.during(() => month(ada)),
        records: await t.queries.during(() => records(ada)),
        heatmap: await t.queries.during(() => get(ada, '/me/insights/heatmap')),
        stats: await t.queries.during(() => get(ada, '/me/profile/stats')),
      };
      expect(long).toEqual(short);
    }, 120_000);
  });

  it('requires sign-in', async () => {
    for (const path of [
      '/me/insights/week',
      '/me/insights/month',
      '/me/insights/heatmap',
      '/me/insights/records',
      '/me/profile/stats',
    ]) {
      await t.http().get(path).expect(401);
    }
  });
});
