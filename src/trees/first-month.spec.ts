import { firstMonthFactor, prorate } from './first-month.js';

const SEPTEMBER = { year: 2026, month: 9 }; // 30 days

describe('first-month proration factor', () => {
  it('is 1 when the user joined before the month', () => {
    expect(firstMonthFactor(SEPTEMBER, '2026-03-14', 25)).toEqual({
      partial: false,
      numerator: 1,
      denominator: 1,
    });
  });

  it('is 1 when the user joined on the first day', () => {
    expect(firstMonthFactor(SEPTEMBER, '2026-09-01', 25)).toEqual({
      partial: false,
      numerator: 1,
      denominator: 1,
    });
  });

  it('is the days remaining (the join day included) over the days in the month', () => {
    expect(firstMonthFactor(SEPTEMBER, '2026-09-16', 25)).toEqual({
      partial: true,
      numerator: 15,
      denominator: 30,
    });
  });

  it('never goes below the floor', () => {
    // 7 / 30 ≈ 23 % < 25 %.
    expect(firstMonthFactor(SEPTEMBER, '2026-09-24', 25)).toEqual({
      partial: true,
      numerator: 25,
      denominator: 100,
    });
    expect(firstMonthFactor(SEPTEMBER, '2026-09-30', 25)).toEqual({
      partial: true,
      numerator: 25,
      denominator: 100,
    });
    // The floor is configuration.
    expect(firstMonthFactor(SEPTEMBER, '2026-09-24', 10)).toEqual({
      partial: true,
      numerator: 7,
      denominator: 30,
    });
  });

  it('counts the days of a leap February', () => {
    expect(firstMonthFactor({ year: 2028, month: 2 }, '2028-02-15', 25)).toEqual({
      partial: true,
      numerator: 15,
      denominator: 29,
    });
    expect(firstMonthFactor({ year: 2026, month: 2 }, '2026-02-15', 25)).toEqual({
      partial: true,
      numerator: 14,
      denominator: 28,
    });
  });
});

describe('prorate', () => {
  it('scales a threshold up to the next whole millisecond', () => {
    expect(prorate(7_200_000, { numerator: 15, denominator: 29 })).toBe(3_724_138);
    expect(prorate(7_200_000, { numerator: 1, denominator: 1 })).toBe(7_200_000);
    expect(prorate(10, { numerator: 25, denominator: 100 })).toBe(3);
  });

  it('keeps a threshold of at least 1', () => {
    expect(prorate(1, { numerator: 25, denominator: 100 })).toBe(1);
  });
});
