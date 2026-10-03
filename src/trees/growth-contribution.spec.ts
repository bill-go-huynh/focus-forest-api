import { growthContributionForDay, monthGrowthMilliseconds } from './growth-contribution.js';
import { day, HOUR, MIN, rulesWith } from '../../test/support/tree-testing.js';

const rules = rulesWith(); // 4 h soft cap, 40 % beyond it

describe('growth contribution of one day', () => {
  it('counts focus up to the soft cap in full', () => {
    expect(growthContributionForDay(0, rules)).toBe(0);
    expect(growthContributionForDay(90 * MIN, rules)).toBe(90 * MIN);
    expect(growthContributionForDay(4 * HOUR - 1, rules)).toBe(4 * HOUR - 1);
    expect(growthContributionForDay(4 * HOUR, rules)).toBe(4 * HOUR);
  });

  it('counts focus beyond the cap at the over-cap rate: 6 h → 4 h + 2 h × 40 % = 4.8 h', () => {
    expect(growthContributionForDay(6 * HOUR, rules)).toBe(4.8 * HOUR);
    expect(growthContributionForDay(4 * HOUR + 1, rules)).toBe(4 * HOUR);
  });

  it('follows the configured rate and cap', () => {
    expect(growthContributionForDay(6 * HOUR, rulesWith({ 'growth.overCapRate': 25 }))).toBe(
      4.5 * HOUR,
    );
    expect(growthContributionForDay(6 * HOUR, rulesWith({ 'growth.overCapRate': 100 }))).toBe(
      6 * HOUR,
    );
    expect(growthContributionForDay(6 * HOUR, rulesWith({ 'growth.overCapRate': 0 }))).toBe(
      4 * HOUR,
    );
    expect(growthContributionForDay(3 * HOUR, rulesWith({ 'growth.dailySoftCap': 120 }))).toBe(
      2 * HOUR + 0.4 * HOUR,
    );
  });

  it('always returns whole milliseconds', () => {
    for (const ms of [4 * HOUR + 7, 4 * HOUR + 333, 9 * HOUR + 1]) {
      expect(Number.isInteger(growthContributionForDay(ms, rules))).toBe(true);
    }
  });
});

describe('growth of a month', () => {
  it('applies the cap per day, not to the month', () => {
    const oneLongDay = [day('2026-09-01', 6 * 60)];
    const twoDays = [day('2026-09-01', 3 * 60), day('2026-09-02', 3 * 60)];
    expect(monthGrowthMilliseconds(oneLongDay, rules)).toBe(4.8 * HOUR);
    expect(monthGrowthMilliseconds(twoDays, rules)).toBe(6 * HOUR);
  });

  it('adds many odd durations exactly, without floating-point drift', () => {
    const days = Array.from({ length: 31 }, (_, index) => ({
      date: `2026-10-${String(index + 1).padStart(2, '0')}`,
      focusedMilliseconds: 4 * HOUR + 333_333,
      sessionCount: 1,
    }));
    // Each day: 4 h + floor(333 333 × 40 / 100) = 4 h + 133 333 ms.
    expect(monthGrowthMilliseconds(days, rules)).toBe(31 * (4 * HOUR + 133_333));
  });
});
