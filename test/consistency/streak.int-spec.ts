import { StreakService } from '../../src/consistency/streak.service.js';
import { ConsistencyHarness, dateRange } from '../support/consistency-harness.js';

const t = new ConsistencyHarness('2026-10-07T12:00:00.000Z');

interface StreakBody {
  current: number;
  longest: number;
  today: string;
  milestones: { reached: number[]; next: number | null };
  recovery: {
    offer: { missedDate: string; returnDate: string; previousStreak: number } | null;
    usedThisMonth: number;
    perMonth: number;
  };
}

describe('streak and recovery (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setToday('2026-10-07');
    await t.activateConfig();
  });

  const streak = async (auth: Record<string, string>) =>
    (await t.http().get('/me/streak').set(auth).expect(200)).body as StreakBody;
  const recover = (auth: Record<string, string>, missedDate: string) =>
    t.http().post('/me/streak/recoveries').set(auth).send({ missedDate });
  const codeOf = (res: { body: unknown }) => (res.body as { code?: string }).code;

  it('counts counted sessions only, one per day, whatever the daily goal', async () => {
    const ada = await t.signUp('ada@example.com');
    await t.focus(ada, [
      ['2026-10-04', 5],
      ['2026-10-05', 6],
      ['2026-10-06', 2, 'discarded'],
      ['2026-10-07', 10],
    ]);
    expect(await streak(ada.auth)).toEqual({
      current: 1,
      longest: 2,
      today: 'active',
      milestones: { reached: [], next: 3 },
      recovery: { offer: null, usedThisMonth: 0, perMonth: 1 },
    });
  });

  it('is bridged by planned rest days without counting them, even with focus on them', async () => {
    const ada = await t.signUp('ada@example.com');
    await t.setToday('2026-10-03');
    await t.http().put('/me/rest-days/2026-10-04').set(ada.auth).expect(201);
    await t.http().put('/me/rest-days/2026-10-05').set(ada.auth).expect(201);
    await t.setToday('2026-10-07');
    await t.focus(ada, [
      ['2026-10-02', 30],
      ['2026-10-03', 30],
      ['2026-10-05', 30], // focus on a rest day
      ['2026-10-06', 30],
    ]);
    expect(await streak(ada.auth)).toMatchObject({ current: 3, today: 'pending' });
  });

  it('reports the milestones of the current streak', async () => {
    const ada = await t.signUp('ada@example.com');
    await t.focus(
      ada,
      dateRange('2026-09-30', 8).map((date) => [date, 10] as [string, number]),
    );
    expect((await streak(ada.auth)).milestones).toEqual({ reached: [3, 7], next: 14 });
  });

  describe('recovery', () => {
    // A 4-day streak on 1–4 October, the 5th missed, back on the 6th.
    async function brokenStreak() {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ...dateRange('2026-10-01', 4).map((date) => [date, 20] as [string, number]),
        ['2026-10-06', 15],
      ]);
      await t.setToday('2026-10-06');
      return ada;
    }

    it('offers to keep the streak after one missed day and a session the next day', async () => {
      const ada = await brokenStreak();
      expect(await streak(ada.auth)).toMatchObject({
        current: 1,
        longest: 4,
        recovery: {
          offer: { missedDate: '2026-10-05', returnDate: '2026-10-06', previousStreak: 4 },
          usedThisMonth: 0,
          perMonth: 1,
        },
      });
    });

    it('keeps the streak once accepted; the missed day bridges without counting', async () => {
      const ada = await brokenStreak();
      const res = await recover(ada.auth, '2026-10-05').expect(201);
      expect(res.body).toMatchObject({
        current: 5,
        longest: 5,
        recovery: { offer: null, usedThisMonth: 1 },
      });
      const stored = await t.prisma.streakRecovery.findMany({ where: { userId: ada.userId } });
      expect(stored).toEqual([
        expect.objectContaining({
          missedDate: new Date('2026-10-05T00:00:00.000Z'),
          returnDate: new Date('2026-10-06T00:00:00.000Z'),
        }),
      ]);
    });

    it('answers a repeated acceptance with the same state, and concurrent ones with one recovery', async () => {
      const ada = await brokenStreak();
      const responses = await Promise.all([
        recover(ada.auth, '2026-10-05'),
        recover(ada.auth, '2026-10-05'),
        recover(ada.auth, '2026-10-05'),
      ]);
      expect(responses.map((res) => res.status).sort()).toEqual([200, 200, 201]);
      await recover(ada.auth, '2026-10-05').expect(200);
      expect(await t.prisma.streakRecovery.count({ where: { userId: ada.userId } })).toBe(1);
    });

    it('allows one recovery per calendar month', async () => {
      const ada = await brokenStreak();
      await recover(ada.auth, '2026-10-05').expect(201);
      // Another 3-day run, a missed day, and a return.
      await t.focus(ada, [
        ['2026-10-07', 10],
        ['2026-10-08', 10],
        ['2026-10-10', 10],
      ]);
      await t.setToday('2026-10-10');
      expect((await streak(ada.auth)).recovery.offer).toBeNull();
      expect(codeOf(await recover(ada.auth, '2026-10-09').expect(422))).toBe(
        'monthly_limit_reached',
      );
    });

    it('refuses what the mechanic cannot repair', async () => {
      const ada = await brokenStreak();
      expect(codeOf(await recover(ada.auth, '2026-10-04').expect(422))).toBe('not_a_missed_day');
      await t.setToday('2026-10-08');
      expect(codeOf(await recover(ada.auth, '2026-10-05').expect(422))).toBe(
        'return_window_passed',
      );
    });

    it('refuses two missed days and a short previous streak', async () => {
      const ada = await t.signUp('ada@example.com');
      await t.focus(ada, [
        ['2026-10-01', 20],
        ['2026-10-02', 20],
        ['2026-10-05', 20],
      ]);
      await t.setToday('2026-10-05');
      expect(codeOf(await recover(ada.auth, '2026-10-04').expect(422))).toBe(
        'more_than_one_missed_day',
      );
      await t.focus(ada, [['2026-10-03', 20]]);
      // Now 1–3 October is a 3-day streak, but a configured minimum of 4 refuses it.
      await t.activateConfig({
        'recovery.mechanics': { nextDaySession: { minPreviousStreak: 4 } },
      });
      expect(codeOf(await recover(ada.auth, '2026-10-04').expect(422))).toBe(
        'previous_streak_too_short',
      );
    });

    it('never counts a recovered day as focus, a goal, or vitality activity', async () => {
      const ada = await brokenStreak();
      await recover(ada.auth, '2026-10-05').expect(201);
      const service = t.app.get(StreakService);
      const input = await service.vitalityInput(ada.userId, '2026-10-06');
      expect(input.activeDates).not.toContain('2026-10-05');
      expect(input.goalMetDates).not.toContain('2026-10-05');
      const goals = (await t.http().get('/me/goals').set(ada.auth).expect(200)).body as {
        daily: { today: { date: string } };
      };
      expect(goals.daily.today.date).toBe('2026-10-06');
    });

    it.each([[{}], [{ missedDate: '2026-02-30' }], [{ missedDate: '2026-10-05', extra: 1 }]])(
      'rejects %j',
      async (body) => {
        const ada = await brokenStreak();
        await t.http().post('/me/streak/recoveries').set(ada.auth).send(body).expect(400);
      },
    );
  });

  it('keeps each user’s streak and recoveries separate', async () => {
    const ada = await t.signUp('ada@example.com');
    const bob = await t.signUp('bob@example.com');
    await t.focus(ada, [
      ['2026-10-06', 10],
      ['2026-10-07', 10],
    ]);
    expect((await streak(bob.auth)).current).toBe(0);
    expect((await streak(ada.auth)).current).toBe(2);
  });

  it('requires sign-in', async () => {
    await t.http().get('/me/streak').expect(401);
    await t.http().post('/me/streak/recoveries').send({ missedDate: '2026-10-05' }).expect(401);
  });
});
