import { growthRulesFrom, vitalityRulesFrom } from './growth-rules.js';
import { configWith, HOUR, MIN } from '../../test/support/tree-testing.js';

describe('growth rules read from Product configuration', () => {
  it('converts the configured minutes into exact milliseconds', () => {
    expect(growthRulesFrom(configWith())).toEqual({
      configVersion: 3,
      stageThresholdsMs: [2 * HOUR, 6 * HOUR, 12 * HOUR, 20 * HOUR, 30 * HOUR],
      dailySoftCapMs: 4 * HOUR,
      overCapPercent: 40,
      firstMonthFloorPercent: 25,
      fullness: {
        activeDaysWeight: 60,
        weeklyConsistencyWeight: 40,
        targetActiveDays: 24,
        activeDaysPerWeek: 3,
        levelPercents: [15, 35, 55, 75, 95],
      },
      blossoms: {
        dailyGoalPoints: 1,
        weeklyGoalPoints: 2,
        levelThresholds: [1, 3, 6, 10, 15, 21, 28],
      },
      richnessTiersMs: [3 * HOUR, 6 * HOUR, 10 * HOUR, 15 * HOUR, 21 * HOUR],
      focusHourMilestones: [10, 25, 40],
    });
  });

  it('follows a changed value without code changes', () => {
    const rules = growthRulesFrom(
      configWith({ 'growth.dailySoftCap': 90, 'growth.stageThresholds': [1, 2, 3, 4, 5] }),
    );
    expect(rules.dailySoftCapMs).toBe(90 * MIN);
    expect(rules.stageThresholdsMs).toEqual([1, 2, 3, 4, 5].map((m) => m * MIN));
  });

  it('reads the vitality rules', () => {
    expect(vitalityRulesFrom(configWith())).toEqual({
      thrivingActiveRunDays: 2,
      healthyWithinDays: 1,
      stableWithinDays: 2,
      goalWindowDays: 4,
      goalMetDaysRequired: 3,
    });
  });
});
