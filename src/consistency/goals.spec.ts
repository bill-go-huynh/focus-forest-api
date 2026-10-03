import { HOUR, MIN, day } from '../../test/support/tree-testing.js';
import {
  dailyEffectiveFrom,
  dailyGoalMinutesOn,
  dailyProgress,
  monthGoalCompletions,
  weeklyEffectiveFrom,
  weeklyGoalForWeek,
  weeklyProgress,
  type DailyGoalVersion,
  type WeeklyGoalVersion,
} from './goals.js';

describe('when a goal setting takes effect', () => {
  it('a first daily goal applies today; a change applies from the next local day', () => {
    expect(dailyEffectiveFrom('2026-10-07', { firstSetting: true })).toBe('2026-10-07');
    expect(dailyEffectiveFrom('2026-10-07', { firstSetting: false })).toBe('2026-10-08');
    expect(dailyEffectiveFrom('2026-10-31', { firstSetting: false })).toBe('2026-11-01');
  });

  it('a weekly goal applies to this week when none is in effect; otherwise from next Monday', () => {
    // 7 October 2026 is a Wednesday.
    expect(weeklyEffectiveFrom('2026-10-07', { goalInEffect: false })).toBe('2026-10-05');
    expect(weeklyEffectiveFrom('2026-10-07', { goalInEffect: true })).toBe('2026-10-12');
    // On a Monday the change still waits a week; on a Sunday it starts the next day.
    expect(weeklyEffectiveFrom('2026-10-05', { goalInEffect: true })).toBe('2026-10-12');
    expect(weeklyEffectiveFrom('2026-10-11', { goalInEffect: true })).toBe('2026-10-12');
  });
});

describe('which goal applied', () => {
  const daily: DailyGoalVersion[] = [
    { effectiveFrom: '2026-10-08', minutes: 60 },
    { effectiveFrom: '2026-10-01', minutes: 45 },
    { effectiveFrom: '2026-10-20', minutes: 20 },
  ];

  it('uses the latest version in effect on the date, in any order', () => {
    expect(dailyGoalMinutesOn(daily, '2026-10-01')).toBe(45);
    expect(dailyGoalMinutesOn(daily, '2026-10-07')).toBe(45);
    expect(dailyGoalMinutesOn(daily, '2026-10-08')).toBe(60);
    expect(dailyGoalMinutesOn(daily, '2026-10-19')).toBe(60);
    expect(dailyGoalMinutesOn(daily, '2026-10-20')).toBe(20);
    expect(dailyGoalMinutesOn(daily, '2027-03-01')).toBe(20);
  });

  it('has no goal before the first persisted daily goal: the display default is not history', () => {
    expect(dailyGoalMinutesOn(daily, '2026-09-30')).toBeNull();
    expect(dailyGoalMinutesOn([], '2026-10-07')).toBeNull();
  });

  it('gives each week the weekly goal in effect on its Monday, or none', () => {
    const weekly: WeeklyGoalVersion[] = [
      { effectiveFrom: '2026-10-05', goal: { type: 'focused_minutes', target: 300 } },
      { effectiveFrom: '2026-10-19', goal: { type: 'session_count', target: 10 } },
      { effectiveFrom: '2026-11-02', goal: null }, // cleared
    ];
    expect(weeklyGoalForWeek(weekly, '2026-09-28')).toBeNull();
    expect(weeklyGoalForWeek(weekly, '2026-10-05')?.target).toBe(300);
    expect(weeklyGoalForWeek(weekly, '2026-10-12')?.target).toBe(300);
    expect(weeklyGoalForWeek(weekly, '2026-10-19')).toEqual({ type: 'session_count', target: 10 });
    expect(weeklyGoalForWeek(weekly, '2026-11-02')).toBeNull();
    expect(weeklyGoalForWeek(weekly, '2027-01-04')).toBeNull();
  });
});

describe('progress', () => {
  it('compares a day of counted focus with its daily goal', () => {
    expect(dailyProgress('2026-10-07', 42 * MIN, 60)).toEqual({
      date: '2026-10-07',
      targetMinutes: 60,
      focusedMinutes: 42,
      remainingMinutes: 18,
      completed: false,
    });
    expect(dailyProgress('2026-10-07', 60 * MIN, 60).completed).toBe(true);
    expect(dailyProgress('2026-10-07', 60 * MIN - 1, 60)).toMatchObject({
      focusedMinutes: 59,
      remainingMinutes: 1,
      completed: false,
    });
    expect(dailyProgress('2026-10-07', 90 * MIN, 60).remainingMinutes).toBe(0);
  });

  it('counts focused minutes or sessions for a week', () => {
    const days = [day('2026-10-05', 120, 2), day('2026-10-07', 100, 3), day('2026-10-11', 80)];
    expect(weeklyProgress('2026-10-05', days, { type: 'focused_minutes', target: 300 })).toEqual({
      weekStart: '2026-10-05',
      type: 'focused_minutes',
      target: 300,
      current: 300,
      completed: true,
    });
    expect(weeklyProgress('2026-10-05', days, { type: 'session_count', target: 7 })).toEqual({
      weekStart: '2026-10-05',
      type: 'session_count',
      target: 7,
      current: 6,
      completed: false,
    });
  });

  it('only counts the days of that Monday-to-Sunday week', () => {
    const days = [day('2026-10-04', 500), day('2026-10-05', 30), day('2026-10-12', 500)];
    expect(
      weeklyProgress('2026-10-05', days, { type: 'focused_minutes', target: 60 }).current,
    ).toBe(30);
  });
});

describe('goal completions of a month (blossom input)', () => {
  const october = { year: 2026, month: 10 };

  it('counts each day against the daily goal in effect that day', () => {
    const result = monthGoalCompletions({
      month: october,
      days: [
        day('2026-09-30', 120), // September: not this month
        day('2026-10-01', 45),
        day('2026-10-02', 50),
        day('2026-10-09', 50), // goal is 60 from the 8th
        day('2026-10-10', 60),
      ],
      dailyVersions: [
        { effectiveFrom: '2026-10-01', minutes: 45 },
        { effectiveFrom: '2026-10-08', minutes: 60 },
      ],
      weeklyVersions: [],
    });
    expect(result.daily).toBe(3);
    expect(result.dailyMetDates).toEqual(['2026-10-01', '2026-10-02', '2026-10-10']);
    expect(result.weekly).toBe(0);
  });

  it('does not rewrite earlier days when the goal is raised later', () => {
    const days = [day('2026-10-01', 45), day('2026-10-02', 45)];
    const before = monthGoalCompletions({
      month: october,
      days,
      dailyVersions: [{ effectiveFrom: '2026-10-01', minutes: 45 }],
      weeklyVersions: [],
    });
    const after = monthGoalCompletions({
      month: october,
      days,
      dailyVersions: [
        { effectiveFrom: '2026-10-01', minutes: 45 },
        { effectiveFrom: '2026-10-03', minutes: 120 },
      ],
      weeklyVersions: [],
    });
    expect(after.daily).toBe(before.daily);
  });

  it('counts a weekly goal in the month of the day it was reached', () => {
    // Week of 28 September: the target is reached on Thursday 1 October.
    const result = monthGoalCompletions({
      month: october,
      days: [
        day('2026-09-28', 100),
        day('2026-09-30', 100),
        day('2026-10-01', 100),
        day('2026-10-05', 20), // the next week: not reached
      ],
      dailyVersions: [{ effectiveFrom: '2026-01-01', minutes: 500 }],
      weeklyVersions: [
        { effectiveFrom: '2026-09-28', goal: { type: 'focused_minutes', target: 300 } },
      ],
    });
    expect(result.weekly).toBe(1);

    const september = monthGoalCompletions({
      month: { year: 2026, month: 9 },
      days: [day('2026-09-28', 100), day('2026-09-30', 100), day('2026-10-01', 100)],
      dailyVersions: [{ effectiveFrom: '2026-01-01', minutes: 500 }],
      weeklyVersions: [
        { effectiveFrom: '2026-09-28', goal: { type: 'focused_minutes', target: 300 } },
      ],
    });
    expect(september.weekly).toBe(0);
  });

  it('counts session-count weekly goals by sessions', () => {
    const result = monthGoalCompletions({
      month: october,
      days: [day('2026-10-05', 10, 2), day('2026-10-06', 10, 1)],
      dailyVersions: [{ effectiveFrom: '2026-01-01', minutes: 500 }],
      weeklyVersions: [{ effectiveFrom: '2026-10-05', goal: { type: 'session_count', target: 3 } }],
    });
    expect(result.weekly).toBe(1);
  });

  it('ignores days without counted sessions', () => {
    const result = monthGoalCompletions({
      month: october,
      days: [{ date: '2026-10-01', focusedMilliseconds: HOUR, sessionCount: 0 }],
      dailyVersions: [],
      weeklyVersions: [],
    });
    expect(result.daily).toBe(0);
  });

  it('counts no daily completion before the first persisted daily goal', () => {
    const result = monthGoalCompletions({
      month: october,
      days: [day('2026-10-01', 120), day('2026-10-02', 120), day('2026-10-03', 120)],
      dailyVersions: [{ effectiveFrom: '2026-10-03', minutes: 30 }],
      weeklyVersions: [],
    });
    expect(result.dailyMetDates).toEqual(['2026-10-03']);
  });

  it('counts no weekly completion in a week whose goal was cleared', () => {
    const result = monthGoalCompletions({
      month: october,
      days: [day('2026-10-05', 200), day('2026-10-12', 200)],
      dailyVersions: [],
      weeklyVersions: [
        { effectiveFrom: '2026-10-05', goal: { type: 'focused_minutes', target: 60 } },
        { effectiveFrom: '2026-10-12', goal: null },
      ],
    });
    expect(result.weekly).toBe(1);
  });
});
