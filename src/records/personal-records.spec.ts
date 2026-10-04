import type { DayFocus } from '../focus-stats/focus-stats.js';
import { newPersonalRecords, personalRecords, type RecordsInput } from './personal-records.js';

const MIN = 60_000;
const day = (date: string, minutes: number, sessionCount = 1): DayFocus => ({
  date,
  focusedMilliseconds: minutes * MIN,
  sessionCount,
});

const input = (partial: Partial<RecordsInput> = {}): RecordsInput => ({
  days: [],
  longestSessions: [],
  activity: { activeDates: [], restDates: [], recoveredDates: [] },
  goalMetDates: [],
  ...partial,
});

describe('personal records', () => {
  it('has no records without focus', () => {
    expect(personalRecords(input(), '2026-10-31')).toEqual([]);
  });

  it('finds each best up to a date, in a fixed order, the earliest on a tie', () => {
    const days = [
      day('2026-09-07', 90), // Monday
      day('2026-09-08', 120),
      day('2026-09-21', 120), // the same as the 8th: the 8th stays the record
      day('2026-10-05', 60),
    ];
    const records = personalRecords(
      input({
        days,
        longestSessions: [
          { date: '2026-09-07', focusedMilliseconds: 50 * MIN },
          { date: '2026-09-08', focusedMilliseconds: 80 * MIN },
        ],
        activity: {
          activeDates: ['2026-09-07', '2026-09-08', '2026-09-21', '2026-10-05'],
          restDates: ['2026-09-09'],
          recoveredDates: [],
        },
        goalMetDates: ['2026-09-07', '2026-09-08', '2026-09-21'],
      }),
      '2026-10-31',
    );
    expect(records).toEqual([
      { kind: 'most_focused_day', value: 120, unit: 'minutes', achievedOn: '2026-09-08' },
      { kind: 'most_focused_week', value: 210, unit: 'minutes', achievedOn: '2026-09-07' },
      { kind: 'most_focused_month', value: 330, unit: 'minutes', achievedOn: '2026-09-01' },
      { kind: 'longest_streak', value: 2, unit: 'days', achievedOn: '2026-09-08' },
      { kind: 'longest_session', value: 80, unit: 'minutes', achievedOn: '2026-09-08' },
      { kind: 'longest_daily_goal_streak', value: 2, unit: 'days', achievedOn: '2026-09-08' },
    ]);
  });

  it('ignores everything after the date', () => {
    const records = personalRecords(
      input({ days: [day('2026-09-08', 30), day('2026-10-05', 300)] }),
      '2026-09-30',
    );
    expect(records.find((record) => record.kind === 'most_focused_day')).toMatchObject({
      value: 30,
      achievedOn: '2026-09-08',
    });
  });

  it('runs weeks from Monday to Sunday', () => {
    // Sunday 11 and Monday 12 October fall in different weeks.
    const records = personalRecords(
      input({ days: [day('2026-10-11', 100), day('2026-10-12', 30), day('2026-10-13', 30)] }),
      '2026-10-31',
    );
    expect(records.find((record) => record.kind === 'most_focused_week')).toEqual({
      kind: 'most_focused_week',
      value: 100,
      unit: 'minutes',
      achievedOn: '2026-10-05',
    });
  });
});

describe('new personal records of a period', () => {
  const september = [day('2026-09-08', 120), day('2026-09-09', 60)];

  it('lists the records the period beat, never one it only matched', () => {
    const records = newPersonalRecords(
      input({
        days: [...september, day('2026-10-05', 120), day('2026-10-06', 100), day('2026-10-07', 10)],
        longestSessions: [
          { date: '2026-09-08', focusedMilliseconds: 120 * MIN },
          { date: '2026-10-06', focusedMilliseconds: 100 * MIN },
        ],
        activity: {
          activeDates: ['2026-09-08', '2026-09-09', '2026-10-05', '2026-10-06', '2026-10-07'],
          restDates: [],
          recoveredDates: [],
        },
      }),
      { from: '2026-10-01', to: '2026-10-31' },
    );
    // Day 120 = September's 120 (not new); session 100 < 120 (not new).
    expect(records.map((record) => record.kind)).toEqual([
      'most_focused_week',
      'most_focused_month',
      'longest_streak',
    ]);
    expect(records[0]).toEqual({
      kind: 'most_focused_week',
      value: 230,
      unit: 'minutes',
      achievedOn: '2026-10-05',
    });
  });

  it('counts every record of a first period with focus as new', () => {
    const records = newPersonalRecords(
      input({
        days: [day('2026-10-05', 40)],
        longestSessions: [{ date: '2026-10-05', focusedMilliseconds: 40 * MIN }],
        activity: { activeDates: ['2026-10-05'], restDates: [], recoveredDates: [] },
      }),
      { from: '2026-10-01', to: '2026-10-31' },
    );
    expect(records.map((record) => record.kind)).toEqual([
      'most_focused_day',
      'most_focused_week',
      'most_focused_month',
      'longest_streak',
      'longest_session',
    ]);
  });

  it('is the same whatever came after the period', () => {
    const base = input({ days: [...september, day('2026-10-05', 200)] });
    const later = input({ days: [...september, day('2026-10-05', 200), day('2026-11-02', 500)] });
    const period = { from: '2026-10-01', to: '2026-10-31' };
    expect(newPersonalRecords(later, period)).toEqual(newPersonalRecords(base, period));
  });
});

describe('longest daily-goal streak', () => {
  const goalStreak = (partial: Partial<RecordsInput>) =>
    personalRecords(input({ days: [day('2026-10-01', 30)], ...partial }), '2026-10-31').find(
      (record) => record.kind === 'longest_daily_goal_streak',
    );

  it('counts consecutive days the daily goal was met', () => {
    expect(
      goalStreak({ goalMetDates: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05'] }),
    ).toMatchObject({ value: 3, achievedOn: '2026-10-03' });
  });

  it('lets planned rest days bridge it without counting them', () => {
    expect(
      goalStreak({
        goalMetDates: ['2026-10-01', '2026-10-02', '2026-10-05'],
        activity: { activeDates: [], restDates: ['2026-10-03', '2026-10-04'], recoveredDates: [] },
      }),
    ).toMatchObject({ value: 3, achievedOn: '2026-10-05' });
  });

  it('is not bridged by a recovered day', () => {
    expect(
      goalStreak({
        goalMetDates: ['2026-10-01', '2026-10-03'],
        activity: { activeDates: [], restDates: [], recoveredDates: ['2026-10-02'] },
      }),
    ).toMatchObject({ value: 1, achievedOn: '2026-10-01' });
  });

  it('keeps the earliest of equal runs', () => {
    expect(
      goalStreak({ goalMetDates: ['2026-10-01', '2026-10-02', '2026-10-10', '2026-10-11'] }),
    ).toMatchObject({ value: 2, achievedOn: '2026-10-02' });
  });
});
