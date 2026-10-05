import {
  longestStreak,
  streakMilestoneEvents,
  summarizeStreak,
  type ActivityHistory,
} from './streak.js';

const history = (partial: Partial<ActivityHistory>): ActivityHistory => ({
  activeDates: [],
  restDates: [],
  recoveredDates: [],
  ...partial,
});

describe('streak', () => {
  it('is 0 before any activity', () => {
    expect(summarizeStreak(history({}), '2026-10-07')).toEqual({
      current: 0,
      longest: 0,
      today: 'pending',
    });
  });

  it('counts consecutive active days; one counted session is enough', () => {
    const h = history({ activeDates: ['2026-10-05', '2026-10-06', '2026-10-07'] });
    expect(summarizeStreak(h, '2026-10-07')).toEqual({ current: 3, longest: 3, today: 'active' });
  });

  it('keeps the streak while today is still in progress', () => {
    const h = history({ activeDates: ['2026-10-05', '2026-10-06'] });
    expect(summarizeStreak(h, '2026-10-07')).toEqual({ current: 2, longest: 2, today: 'pending' });
  });

  it('ends after a day without focus', () => {
    const h = history({ activeDates: ['2026-10-03', '2026-10-04', '2026-10-06', '2026-10-07'] });
    expect(summarizeStreak(h, '2026-10-07')).toEqual({ current: 2, longest: 2, today: 'active' });
    expect(summarizeStreak(history({ activeDates: ['2026-10-05'] }), '2026-10-07').current).toBe(0);
  });

  it('is bridged by rest days, which do not add to it', () => {
    const h = history({
      activeDates: ['2026-10-03', '2026-10-06', '2026-10-07'],
      restDates: ['2026-10-04', '2026-10-05'],
    });
    expect(summarizeStreak(h, '2026-10-07')).toEqual({ current: 3, longest: 3, today: 'active' });
  });

  it('treats a rest day with focus as a rest day: it bridges but does not count', () => {
    const h = history({
      activeDates: ['2026-10-05', '2026-10-06', '2026-10-07'],
      restDates: ['2026-10-06'],
    });
    expect(summarizeStreak(h, '2026-10-07').current).toBe(2);
    expect(summarizeStreak(h, '2026-10-06').today).toBe('rest');
  });

  it('is bridged by a recovered day, which does not add to it', () => {
    const h = history({
      activeDates: ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-06', '2026-10-07'],
      recoveredDates: ['2026-10-05'],
    });
    expect(summarizeStreak(h, '2026-10-07')).toEqual({ current: 5, longest: 5, today: 'active' });
  });

  it('keeps the longest streak after the current one ends', () => {
    const h = history({
      activeDates: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-10-06'],
    });
    expect(summarizeStreak(h, '2026-10-07')).toEqual({ current: 1, longest: 4, today: 'pending' });
  });

  it('runs across month ends and a leap day', () => {
    const h = history({ activeDates: ['2028-02-28', '2028-02-29', '2028-03-01'] });
    expect(summarizeStreak(h, '2028-03-01').current).toBe(3);
    const yearEnd = history({ activeDates: ['2026-12-31', '2027-01-01'] });
    expect(summarizeStreak(yearEnd, '2027-01-01').current).toBe(2);
  });

  it('ignores activity after today and the order of the dates', () => {
    const h = history({ activeDates: ['2026-10-09', '2026-10-07', '2026-10-06'] });
    expect(summarizeStreak(h, '2026-10-07')).toEqual({ current: 2, longest: 2, today: 'active' });
  });
});

describe('longest streak without a today (achievements, A4.2)', () => {
  it('is the longest streak the streak summary reports', () => {
    const cases = [
      history({}),
      history({
        activeDates: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-10-06'],
      }),
      history({ activeDates: ['2026-09-01', '2026-09-03'], restDates: ['2026-09-02'] }),
      history({ activeDates: ['2026-09-01', '2026-09-03'], recoveredDates: ['2026-09-02'] }),
      history({ activeDates: ['2026-09-01'], restDates: ['2026-09-02', '2026-10-20'] }),
    ];
    for (const h of cases) {
      expect(longestStreak(h)).toBe(summarizeStreak(h, '2026-10-07').longest);
    }
    expect(longestStreak(cases[1]!)).toBe(4);
    expect(longestStreak(cases[2]!)).toBe(2);
  });
});

describe('streak milestones', () => {
  const milestones = [3, 7, 14];

  it('reports the date each milestone was reached, with a stable trait id', () => {
    const active = Array.from({ length: 8 }, (_, i) => `2026-10-0${i + 1}`);
    const events = streakMilestoneEvents(
      history({ activeDates: active }),
      '2026-10-08',
      milestones,
    );
    expect(events).toEqual([
      { days: 3, date: '2026-10-03', traitId: 'streak-days:3' },
      { days: 7, date: '2026-10-07', traitId: 'streak-days:7' },
    ]);
  });

  it('counts only active days toward milestones: rest days bridge without counting', () => {
    const events = streakMilestoneEvents(
      history({
        activeDates: ['2026-10-01', '2026-10-02', '2026-10-04'],
        restDates: ['2026-10-03'],
      }),
      '2026-10-04',
      milestones,
    );
    expect(events).toEqual([{ days: 3, date: '2026-10-04', traitId: 'streak-days:3' }]);
  });

  it('reports a milestone again for a new streak, once per streak', () => {
    const events = streakMilestoneEvents(
      history({
        activeDates: [
          '2026-10-01',
          '2026-10-02',
          '2026-10-03',
          '2026-10-04',
          '2026-10-10',
          '2026-10-11',
          '2026-10-12',
        ],
      }),
      '2026-10-12',
      milestones,
    );
    expect(events.map((event) => event.date)).toEqual(['2026-10-03', '2026-10-12']);
  });

  it('follows the configured milestones', () => {
    const events = streakMilestoneEvents(
      history({ activeDates: ['2026-10-01', '2026-10-02'] }),
      '2026-10-02',
      [2, 2],
    );
    expect(events).toEqual([{ days: 2, date: '2026-10-02', traitId: 'streak-days:2' }]);
  });
});
