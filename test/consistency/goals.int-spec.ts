import { GoalsService } from '../../src/consistency/goals.service.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

// Wednesday 7 October 2026; the week runs 5–11 October.
const t = new ConsistencyHarness('2026-10-07T12:00:00.000Z');

describe('goals (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setToday('2026-10-07');
    await t.activateConfig();
  });

  const getGoals = (auth: Record<string, string>) => t.http().get('/me/goals').set(auth);
  const putDaily = (auth: Record<string, string>, body: object) =>
    t.http().put('/me/goals/daily').set(auth).send(body);
  const putWeekly = (auth: Record<string, string>, body: object) =>
    t.http().put('/me/goals/weekly').set(auth).send(body);
  const clearWeekly = (auth: Record<string, string>) =>
    t.http().delete('/me/goals/weekly').set(auth);
  const weeklyOf = (res: { body: unknown }) => (res.body as { weekly: unknown }).weekly;

  describe('reading', () => {
    it('starts with the default daily goal, no weekly goal, and today’s progress', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-10-07', 20],
        ['2026-10-07', 3, 'discarded'],
        ['2026-10-06', 50],
      ]);

      const res = await getGoals(ada.auth).expect(200);
      expect(res.body).toEqual({
        daily: {
          minutes: 30,
          isDefault: true,
          pending: null,
          today: {
            date: '2026-10-07',
            targetMinutes: 30,
            focusedMinutes: 20,
            remainingMinutes: 10,
            completed: false,
          },
        },
        weekly: { goal: null, pending: null, thisWeek: null },
      });
    });

    it('requires sign-in', async () => {
      await t.http().get('/me/goals').expect(401);
    });

    it('needs a time zone to know what today is', async () => {
      const ada = await t.signUp('ada@example.com', null);
      const res = await getGoals(ada.auth).expect(422);
      expect((res.body as { code: string }).code).toBe('timezone_required');
    });

    it('uses the user’s local date, not the server’s', async () => {
      // 18:00 UTC on 7 October is already 8 October in Ho Chi Minh City.
      const ada = await t.signUp('ada@example.com', 'Asia/Ho_Chi_Minh');
      await t.setNow('2026-10-07T18:00:00.000Z');
      const res = await getGoals(ada.auth).expect(200);
      expect((res.body as { daily: { today: { date: string } } }).daily.today.date).toBe(
        '2026-10-08',
      );
    });
  });

  describe('daily goal', () => {
    it('applies a first goal today', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [['2026-10-07', 45]]);

      const res = await putDaily(ada.auth, { minutes: 45 }).expect(200);
      expect(res.body).toMatchObject({
        daily: {
          minutes: 45,
          isDefault: false,
          pending: null,
          today: { targetMinutes: 45, completed: true, remainingMinutes: 0 },
        },
      });
    });

    it('applies a change from the next local day and keeps today’s goal', async () => {
      const ada = await t.signUp('ada@example.com');
      await putDaily(ada.auth, { minutes: 45 }).expect(200);

      const res = await putDaily(ada.auth, { minutes: 90 }).expect(200);
      expect(res.body).toMatchObject({
        daily: {
          minutes: 45,
          pending: { minutes: 90, effectiveFrom: '2026-10-08' },
          today: { targetMinutes: 45 },
        },
      });

      await t.setToday('2026-10-08');
      expect((await getGoals(ada.auth).expect(200)).body).toMatchObject({
        daily: { minutes: 90, pending: null, today: { date: '2026-10-08', targetMinutes: 90 } },
      });
    });

    it('stores one version per date: repeating or undoing a change leaves no duplicates', async () => {
      const ada = await t.signUp('ada@example.com');
      await putDaily(ada.auth, { minutes: 45 }).expect(200);
      await putDaily(ada.auth, { minutes: 90 }).expect(200);
      await putDaily(ada.auth, { minutes: 90 }).expect(200);
      expect(await t.prisma.dailyGoalSetting.count({ where: { userId: ada.userId } })).toBe(2);

      // Back to today's value: the pending change disappears.
      const res = await putDaily(ada.auth, { minutes: 45 }).expect(200);
      expect((res.body as { daily: { pending: unknown } }).daily.pending).toBeNull();
      expect(await t.prisma.dailyGoalSetting.count({ where: { userId: ada.userId } })).toBe(1);
    });

    it.each([
      [{ minutes: 0 }],
      [{ minutes: 1441 }],
      [{ minutes: 2.5 }],
      [{ minutes: '30' }],
      [{}],
      [{ minutes: 30, extra: true }],
    ])('rejects %j', async (body) => {
      const ada = await t.signUp('ada@example.com');
      await putDaily(ada.auth, body).expect(400);
    });
  });

  describe('weekly goal', () => {
    it('applies a first goal to the current week, counting minutes', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-10-04', 200], // Sunday of the previous week
        ['2026-10-05', 100],
        ['2026-10-07', 50],
        ['2026-10-07', 4, 'discarded'],
      ]);

      const res = await putWeekly(ada.auth, { type: 'focused_minutes', target: 300 }).expect(200);
      expect((res.body as { weekly: unknown }).weekly).toEqual({
        goal: { type: 'focused_minutes', target: 300 },
        pending: null,
        thisWeek: {
          weekStart: '2026-10-05',
          type: 'focused_minutes',
          target: 300,
          current: 150,
          completed: false,
        },
      });
    });

    it('counts sessions for a session-count goal', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-10-05', 10],
        ['2026-10-06', 10],
        ['2026-10-06', 2, 'discarded'],
      ]);
      const res = await putWeekly(ada.auth, { type: 'session_count', target: 2 }).expect(200);
      expect((res.body as { weekly: { thisWeek: unknown } }).weekly.thisWeek).toMatchObject({
        current: 2,
        completed: true,
      });
    });

    it('applies a change from the next Monday', async () => {
      const ada = await t.signUp('ada@example.com');
      await putWeekly(ada.auth, { type: 'focused_minutes', target: 300 }).expect(200);
      const res = await putWeekly(ada.auth, { type: 'session_count', target: 10 }).expect(200);
      expect((res.body as { weekly: unknown }).weekly).toMatchObject({
        goal: { type: 'focused_minutes', target: 300 },
        pending: { goal: { type: 'session_count', target: 10 }, effectiveFrom: '2026-10-12' },
      });

      await t.setToday('2026-10-11'); // Sunday: still the old goal
      expect((await getGoals(ada.auth).expect(200)).body).toMatchObject({
        weekly: { goal: { target: 300 } },
      });
      await t.setToday('2026-10-12');
      expect((await getGoals(ada.auth).expect(200)).body).toMatchObject({
        weekly: { goal: { type: 'session_count', target: 10 }, pending: null },
      });
    });

    it.each([
      [{ type: 'hours', target: 5 }],
      [{ type: 'focused_minutes', target: 0 }],
      [{ type: 'focused_minutes', target: 10081 }],
      [{ type: 'session_count', target: 501 }],
      [{ type: 'session_count' }],
      [{ type: 'session_count', target: 5, extra: 1 }],
    ])('rejects %j', async (body) => {
      const ada = await t.signUp('ada@example.com');
      await putWeekly(ada.auth, body).expect(400);
    });
  });

  describe('clearing the weekly goal', () => {
    it('does nothing when there never was one', async () => {
      const ada = await t.signUp('ada@example.com');
      expect(weeklyOf(await clearWeekly(ada.auth).expect(200))).toEqual({
        goal: null,
        pending: null,
        thisWeek: null,
      });
      expect(await t.prisma.weeklyGoalSetting.count()).toBe(0);
    });

    it('ends the current goal from the next Monday, keeping this week and past weeks', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.setToday('2026-09-30');
      await putWeekly(ada.auth, { type: 'session_count', target: 1 }).expect(200);
      await t.focus(ada, [['2026-10-01', 20]]);
      await t.setToday('2026-10-07');

      expect(weeklyOf(await clearWeekly(ada.auth).expect(200))).toMatchObject({
        goal: { type: 'session_count', target: 1 },
        pending: { goal: null, effectiveFrom: '2026-10-12' },
      });
      // Repeating the clear changes nothing.
      await clearWeekly(ada.auth).expect(200);
      expect(await t.prisma.weeklyGoalSetting.count({ where: { userId: ada.userId } })).toBe(2);

      await t.setToday('2026-10-12');
      expect(weeklyOf(await t.http().get('/me/goals').set(ada.auth).expect(200))).toEqual({
        goal: null,
        pending: null,
        thisWeek: null,
      });
      // The week of 28 September still had its goal, met on 1 October.
      const goals = t.app.get(GoalsService);
      expect((await goals.monthCompletions(ada.userId, { year: 2026, month: 10 })).weekly).toBe(1);
    });

    it('can be replaced by another pending goal, or undone by setting the current one', async () => {
      const ada = await t.signUp('ada@example.com');
      await putWeekly(ada.auth, { type: 'focused_minutes', target: 300 }).expect(200);
      await clearWeekly(ada.auth).expect(200);
      expect(
        weeklyOf(await putWeekly(ada.auth, { type: 'session_count', target: 5 }).expect(200)),
      ).toMatchObject({
        goal: { type: 'focused_minutes', target: 300 },
        pending: { goal: { type: 'session_count', target: 5 }, effectiveFrom: '2026-10-12' },
      });

      await clearWeekly(ada.auth).expect(200);
      expect(
        weeklyOf(await putWeekly(ada.auth, { type: 'focused_minutes', target: 300 }).expect(200)),
      ).toMatchObject({ goal: { target: 300 }, pending: null });
    });

    it('lets a new goal start in the current week once none is in effect', async () => {
      const ada = await t.signUp('ada@example.com');
      await putWeekly(ada.auth, { type: 'focused_minutes', target: 300 }).expect(200);
      await clearWeekly(ada.auth).expect(200);
      await t.setToday('2026-10-14');
      expect(
        weeklyOf(await putWeekly(ada.auth, { type: 'session_count', target: 3 }).expect(200)),
      ).toMatchObject({ goal: { type: 'session_count', target: 3 }, pending: null });
    });
  });

  describe('history before the first daily goal', () => {
    it('has no daily completions, whatever the configured default is now', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-10-01', 40],
        ['2026-10-02', 40],
      ]);
      const goals = t.app.get(GoalsService);
      const october = { year: 2026, month: 10 };
      expect((await goals.monthCompletions(ada.userId, october)).daily).toBe(0);

      await t.activateConfig({ 'goal.dailyDefaultMinutes': 10 });
      expect((await goals.monthCompletions(ada.userId, october)).daily).toBe(0);
      // The display still shows the default until the user sets a goal.
      expect((await getGoals(ada.auth).expect(200)).body).toMatchObject({
        daily: { minutes: 10, isDefault: true },
      });

      await putDaily(ada.auth, { minutes: 30 }).expect(200); // first goal: from today, 7 October
      expect((await goals.monthCompletions(ada.userId, october)).daily).toBe(0);
    });
  });

  it('keeps each user’s goals separate', async () => {
    const ada = await t.signUp('ada@example.com');
    const bob = await t.signUp('bob@example.com');
    await putDaily(ada.auth, { minutes: 90 }).expect(200);
    await putWeekly(ada.auth, { type: 'session_count', target: 5 }).expect(200);
    expect((await getGoals(bob.auth).expect(200)).body).toMatchObject({
      daily: { minutes: 30, isDefault: true },
      weekly: { goal: null },
    });
  });

  describe('goal completions of a month (blossom input for the tree)', () => {
    it('judges each day and week by the goal in effect then, even after later changes', async () => {
      const ada = await t.signUp('ada@example.com');
      const goals = t.app.get(GoalsService);
      await t.setToday('2026-10-01');
      await putDaily(ada.auth, { minutes: 45 }).expect(200);
      await putWeekly(ada.auth, { type: 'session_count', target: 2 }).expect(200);
      await t.focus(ada, [
        ['2026-10-01', 45],
        ['2026-10-02', 45],
        ['2026-10-02', 3, 'discarded'],
        ['2026-10-05', 30], // week of 5 October: one session, not reached
      ]);
      const before = await goals.monthCompletions(ada.userId, { year: 2026, month: 10 });
      expect(before).toEqual({
        daily: 2,
        weekly: 1,
        dailyMetDates: ['2026-10-01', '2026-10-02'],
      });

      await t.setToday('2026-10-03');
      await putDaily(ada.auth, { minutes: 120 }).expect(200);
      await putWeekly(ada.auth, { type: 'session_count', target: 20 }).expect(200);
      expect(await goals.monthCompletions(ada.userId, { year: 2026, month: 10 })).toEqual(before);
    });
  });
});
