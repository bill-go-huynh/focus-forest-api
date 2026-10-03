import { vitalityRulesWith } from '../../test/support/tree-testing.js';
import { vitalityOn, type VitalityInput } from './vitality.js';

const rules = vitalityRulesWith(); // thriving after a 2-day run; healthy ≤ 1 day; stable ≤ 2 days
const TODAY = '2026-10-10';

const vitality = (input: Partial<VitalityInput>, withRules = rules) =>
  vitalityOn({ today: TODAY, activeDates: [], restDates: [], ...input }, withRules);

describe('vitality', () => {
  describe('active today', () => {
    it('is Thriving on a run of active days', () => {
      expect(vitality({ activeDates: ['2026-10-09', '2026-10-10'] })).toBe('thriving');
    });

    it('is Healthy without a run', () => {
      expect(vitality({ activeDates: ['2026-10-08', '2026-10-10'] })).toBe('healthy');
      expect(vitality({ activeDates: ['2026-10-10'] })).toBe('healthy');
    });

    it('is Recovering on the first focus after a Quiet stretch', () => {
      // 08, 09 and 10 without focus before today's session: Quiet → Recovering.
      expect(vitality({ activeDates: ['2026-10-07', '2026-10-10'] })).toBe('recovering');
      expect(vitality({ activeDates: ['2026-08-01', '2026-10-10'] })).toBe('recovering');
    });

    it('counts planned rest days as neither gap nor run', () => {
      // Rest on the 8th and 9th: the gap before today is only today → not Recovering,
      // and the run 07 → 10 is bridged by the rest days.
      expect(
        vitality({
          activeDates: ['2026-10-06', '2026-10-07', '2026-10-10'],
          restDates: ['2026-10-08', '2026-10-09'],
        }),
      ).toBe('thriving');
    });
  });

  describe('not active today', () => {
    it.each([
      ['2026-10-09', 'healthy'],
      ['2026-10-08', 'stable'],
      ['2026-10-07', 'quiet'],
      ['2026-09-01', 'quiet'],
    ])('last active on %s → %s', (last, state) => {
      expect(vitality({ activeDates: [last] })).toBe(state);
    });

    it('does not count planned rest days, including today, as days without focus', () => {
      expect(
        vitality({ activeDates: ['2026-10-07'], restDates: ['2026-10-08', '2026-10-09'] }),
      ).toBe('healthy');
      expect(
        vitality({
          activeDates: ['2026-10-07'],
          restDates: ['2026-10-08', '2026-10-09', '2026-10-10'],
        }),
      ).toBe('healthy');
    });

    it('is Healthy for a user who has never focused yet', () => {
      expect(vitality({})).toBe('healthy');
    });
  });

  it('reads the evaluation date from its input, never from a clock', () => {
    const input = { activeDates: ['2026-10-07'] };
    expect(vitality(input)).toBe('quiet');
    expect(vitality({ ...input, today: '2026-10-08' })).toBe('healthy');
  });

  it('ignores activity after the evaluation date and the order of the dates', () => {
    expect(vitality({ activeDates: ['2026-10-12', '2026-10-07'] })).toBe('quiet');
    expect(vitality({ activeDates: ['2026-10-10', '2026-10-09'] })).toBe('thriving');
  });

  it('follows the configured day thresholds', () => {
    const relaxed = vitalityRulesWith({
      'vitality.rules': { thrivingActiveRunDays: 3, healthyWithinDays: 2, stableWithinDays: 4 },
    });
    expect(vitality({ activeDates: ['2026-10-09', '2026-10-10'] }, relaxed)).toBe('healthy');
    expect(vitality({ activeDates: ['2026-10-08'] }, relaxed)).toBe('healthy');
    expect(vitality({ activeDates: ['2026-10-07'] }, relaxed)).toBe('stable');
    expect(vitality({ activeDates: ['2026-10-05'] }, relaxed)).toBe('quiet');
  });
});
