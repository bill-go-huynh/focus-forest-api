import { cohortMetrics, GAP_DAYS, userMetrics, type UserActivity } from './checkpoint-metrics.js';

const activity = (overrides: Partial<UserActivity> = {}): UserActivity => ({
  userId: 'u1',
  joinedOn: '2026-09-03',
  today: '2026-10-08',
  openDates: [],
  focusDates: [],
  firstArchive: null,
  ...overrides,
});

describe('Core Loop Checkpoint metrics (CR.2)', () => {
  it('counts active days per month: an open, a foreground, or a counted session, once a day', () => {
    const m = userMetrics(
      activity({
        openDates: ['2026-09-03', '2026-09-04', '2026-09-20'],
        focusDates: ['2026-09-04', '2026-09-05', '2026-10-01'],
      }),
    );
    expect(m.months).toEqual([
      { year: 2026, month: 9, activeDays: 4, focusDays: 2 },
      { year: 2026, month: 10, activeDays: 1, focusDays: 1 },
    ]);
    expect(m.activeDays).toBe(5);
    expect(m.lastActiveOn).toBe('2026-10-01');
    expect(m.daysSinceLastActive).toBe(7);
  });

  it(`counts a return after ${GAP_DAYS} or more days without activity`, () => {
    const returns = (dates: string[]) => userMetrics(activity({ openDates: dates })).gapReturns;
    expect(returns(['2026-09-03', '2026-09-06'])).toBe(0); // 2 quiet days
    expect(returns(['2026-09-03', '2026-09-07'])).toBe(1); // 3 quiet days
    expect(returns(['2026-09-03', '2026-09-07', '2026-09-08', '2026-09-20'])).toBe(2);
    expect(returns([])).toBe(0);
  });

  it('decides the second-month return only once it is known', () => {
    const second = (overrides: Partial<UserActivity>) =>
      userMetrics(activity({ firstArchive: { year: 2026, month: 9 }, ...overrides }))
        .secondMonthReturn;
    expect(second({ today: '2026-10-08', openDates: ['2026-10-02'] })).toBe(true);
    // October is not over and nothing yet: not decided.
    expect(second({ today: '2026-10-08', openDates: ['2026-09-29'] })).toBeNull();
    // October ended without activity: did not return.
    expect(second({ today: '2026-11-02', openDates: ['2026-09-29', '2026-11-01'] })).toBe(false);
    // A December archive returns in January of the next year.
    expect(
      userMetrics(
        activity({
          firstArchive: { year: 2026, month: 12 },
          today: '2027-01-05',
          focusDates: ['2027-01-04'],
        }),
      ).secondMonthReturn,
    ).toBe(true);
    expect(userMetrics(activity()).secondMonthReturn).toBeNull();
  });

  it('summarizes a cohort in counts, never percentages', () => {
    const users = [
      userMetrics(activity({ userId: 'a', openDates: ['2026-09-03', '2026-09-04', '2026-09-10'] })),
      userMetrics(activity({ userId: 'b', openDates: ['2026-09-03'] })),
      userMetrics(
        activity({
          userId: 'c',
          joinedOn: '2026-08-30',
          openDates: ['2026-08-30', '2026-08-31', '2026-10-02'],
          firstArchive: { year: 2026, month: 8 },
          today: '2026-10-08',
        }),
      ),
    ];
    expect(cohortMetrics(users)).toEqual({
      users: 3,
      multiDayFirstMonth: 2,
      returnedAfterGap: 2,
      secondMonth: { decided: 1, returned: 0 },
      medianFirstMonthActiveDays: 2,
    });
    expect(cohortMetrics([])).toEqual({
      users: 0,
      multiDayFirstMonth: 0,
      returnedAfterGap: 0,
      secondMonth: { decided: 0, returned: 0 },
      medianFirstMonthActiveDays: null,
    });
  });
});
