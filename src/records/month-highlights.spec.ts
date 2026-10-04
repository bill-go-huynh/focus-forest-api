import type { DayFocus } from '../focus-stats/focus-stats.js';
import { longestStreakWithin, mostProductiveDay, mostProductiveWeek } from './month-highlights.js';

const MIN = 60_000;
const day = (date: string, minutes: number): DayFocus => ({
  date,
  focusedMilliseconds: minutes * MIN,
  sessionCount: 1,
});
const OCTOBER = { year: 2026, month: 10 };

describe('most productive day of a month', () => {
  it('is the day with the most counted focus, the earliest on a tie', () => {
    expect(
      mostProductiveDay(
        [
          day('2026-09-30', 500),
          day('2026-10-06', 90),
          day('2026-10-05', 90),
          day('2026-10-07', 20),
        ],
        OCTOBER,
      ),
    ).toEqual({ date: '2026-10-05', focusedMinutes: 90 });
  });

  it('is null for a month without focus', () => {
    expect(mostProductiveDay([day('2026-11-01', 30)], OCTOBER)).toBeNull();
  });
});

describe('most productive week of a month', () => {
  it('runs Monday to Sunday and counts only the month’s own days', () => {
    // Monday 28 September to Sunday 4 October: only 1–4 October count.
    const days = [
      day('2026-09-28', 400),
      day('2026-10-01', 100),
      day('2026-10-11', 100), // Sunday: the week of 5 October
      day('2026-10-12', 30), // Monday: the week of 12 October
      day('2026-10-13', 30),
    ];
    expect(mostProductiveWeek(days, OCTOBER)).toEqual({
      weekStart: '2026-09-28',
      focusedMinutes: 100,
    });
  });

  it('takes the earliest week on a tie, and is null without focus', () => {
    expect(mostProductiveWeek([day('2026-10-14', 60), day('2026-10-06', 60)], OCTOBER)).toEqual({
      weekStart: '2026-10-05',
      focusedMinutes: 60,
    });
    expect(mostProductiveWeek([], OCTOBER)).toBeNull();
  });
});

describe('longest streak within a month', () => {
  it('is the longest run any day of the month reached, days before the month included', () => {
    const history = {
      activeDates: ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-10'],
      restDates: ['2026-10-03'],
      recoveredDates: [],
    };
    expect(longestStreakWithin(history, '2026-10-01', '2026-10-31')).toBe(4);
    expect(longestStreakWithin(history, '2026-10-05', '2026-10-31')).toBe(1);
  });

  it('ignores runs after the month', () => {
    const history = {
      activeDates: ['2026-10-31', '2026-11-01', '2026-11-02'],
      restDates: [],
      recoveredDates: [],
    };
    expect(longestStreakWithin(history, '2026-10-01', '2026-10-31')).toBe(1);
    expect(longestStreakWithin({ ...history, activeDates: [] }, '2026-10-01', '2026-10-31')).toBe(
      0,
    );
  });
});
