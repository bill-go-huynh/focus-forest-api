import { evaluateRecovery, recoveryOffer, type RecoveryRules } from './recovery.js';
import type { ActivityHistory } from './streak.js';

const rules: RecoveryRules = { minPreviousStreak: 3, perMonth: 1 };

// A 4-day streak (1–4 October), then the 5th missed.
const STREAK = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
const history = (partial: Partial<ActivityHistory> = {}): ActivityHistory => ({
  activeDates: [...STREAK, '2026-10-06'],
  restDates: [],
  recoveredDates: [],
  ...partial,
});
const evaluate = (
  partial: Partial<Parameters<typeof evaluateRecovery>[0]> = {},
  withRules = rules,
) =>
  evaluateRecovery(
    {
      missedDate: '2026-10-05',
      today: '2026-10-06',
      history: history(),
      recoveredDatesThisMonth: [],
      ...partial,
    },
    withRules,
  );

describe('streak recovery eligibility', () => {
  it('is eligible after one missed day, a streak of at least 3, and a session the next day', () => {
    expect(evaluate()).toEqual({
      eligible: true,
      missedDate: '2026-10-05',
      returnDate: '2026-10-06',
      previousStreak: 4,
    });
  });

  it('stays available until the end of the day after the return', () => {
    expect(evaluate({ today: '2026-10-07' }).eligible).toBe(true);
    expect(evaluate({ today: '2026-10-08' })).toEqual({
      eligible: false,
      reason: 'return_window_passed',
    });
  });

  it('needs a counted session on the day right after the missed day', () => {
    expect(evaluate({ history: history({ activeDates: STREAK }) })).toEqual({
      eligible: false,
      reason: 'no_return_session',
    });
    // Focus two days later is not a return the next day.
    expect(
      evaluate({
        history: history({ activeDates: [...STREAK, '2026-10-07'] }),
        today: '2026-10-07',
      }),
    ).toEqual({ eligible: false, reason: 'no_return_session' });
  });

  it('needs a previous streak of at least the configured minimum', () => {
    const short = history({ activeDates: ['2026-10-03', '2026-10-04', '2026-10-06'] });
    expect(evaluate({ history: short })).toEqual({
      eligible: false,
      reason: 'previous_streak_too_short',
    });
    expect(evaluate({ history: short }, { ...rules, minPreviousStreak: 2 }).eligible).toBe(true);
  });

  it('calls no streak at all before the missed day a streak too short', () => {
    // Nothing before 5 October: the previous streak is 0, not a second missed day.
    expect(evaluate({ history: history({ activeDates: ['2026-10-06'] }) })).toEqual({
      eligible: false,
      reason: 'previous_streak_too_short',
    });
  });

  it('repairs exactly one missed day, not two', () => {
    const twoMissed = history({ activeDates: [...STREAK.slice(0, 3), '2026-10-06'] });
    // 4 and 5 October both missed.
    expect(evaluate({ history: twoMissed })).toEqual({
      eligible: false,
      reason: 'more_than_one_missed_day',
    });
  });

  it('counts rest days before the missed day as bridges, not as missed days', () => {
    const withRest = history({
      activeDates: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06'],
      restDates: ['2026-10-04'],
    });
    expect(evaluate({ history: withRest })).toMatchObject({ eligible: true, previousStreak: 3 });
  });

  it('has nothing to repair on a rest day, an active day, or a day already recovered', () => {
    expect(evaluate({ history: history({ restDates: ['2026-10-05'] }) })).toEqual({
      eligible: false,
      reason: 'not_a_missed_day',
    });
    expect(
      evaluate({ history: history({ activeDates: [...STREAK, '2026-10-05', '2026-10-06'] }) }),
    ).toEqual({ eligible: false, reason: 'not_a_missed_day' });
    expect(evaluate({ history: history({ recoveredDates: ['2026-10-05'] }) })).toEqual({
      eligible: false,
      reason: 'already_recovered',
    });
    expect(evaluate({ missedDate: '2026-10-06', today: '2026-10-06' })).toEqual({
      eligible: false,
      reason: 'not_a_missed_day',
    });
  });

  it('allows the configured number of recoveries per calendar month of the missed day', () => {
    expect(evaluate({ recoveredDatesThisMonth: ['2026-10-02'] })).toEqual({
      eligible: false,
      reason: 'monthly_limit_reached',
    });
    expect(
      evaluate({ recoveredDatesThisMonth: ['2026-10-02'] }, { ...rules, perMonth: 2 }).eligible,
    ).toBe(true);
  });
});

describe('recovery offer', () => {
  it('offers the missed day when today is the return day', () => {
    expect(
      recoveryOffer(
        { today: '2026-10-06', history: history(), recoveredDatesByMonth: () => [] },
        rules,
      ),
    ).toEqual({ missedDate: '2026-10-05', returnDate: '2026-10-06', previousStreak: 4 });
  });

  it('still offers it the next day, before any focus that day', () => {
    expect(
      recoveryOffer(
        { today: '2026-10-07', history: history(), recoveredDatesByMonth: () => [] },
        rules,
      ),
    ).toMatchObject({ missedDate: '2026-10-05' });
  });

  it('offers nothing when nothing can be repaired', () => {
    expect(
      recoveryOffer(
        {
          today: '2026-10-06',
          history: history({ activeDates: [...STREAK, '2026-10-05', '2026-10-06'] }),
          recoveredDatesByMonth: () => [],
        },
        rules,
      ),
    ).toBeNull();
    expect(
      recoveryOffer(
        { today: '2026-10-06', history: history(), recoveredDatesByMonth: () => ['2026-10-01'] },
        rules,
      ),
    ).toBeNull();
  });
});
