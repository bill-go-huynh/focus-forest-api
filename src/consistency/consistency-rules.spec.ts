import { configWith } from '../../test/support/tree-testing.js';
import { consistencyRulesFrom } from './consistency-rules.js';

describe('consistency rules read from Product configuration', () => {
  it('reads goals, rest days, streak milestones, and recovery', () => {
    expect(consistencyRulesFrom(configWith())).toEqual({
      configVersion: 3,
      dailyGoalDefaultMinutes: 30,
      restDays: { maxPerWeek: 2, allowSameDay: true },
      streakMilestones: [3, 7, 14, 30, 60, 100],
      recovery: { minPreviousStreak: 3, perMonth: 1 },
    });
  });

  it('follows changed values without code changes', () => {
    const rules = consistencyRulesFrom(
      configWith({
        'restDay.maxPerWeek': 1,
        'recovery.limit': { perMonth: 2 },
        'recovery.mechanics': { nextDaySession: { minPreviousStreak: 5 } },
      }),
    );
    expect(rules.restDays.maxPerWeek).toBe(1);
    expect(rules.recovery).toEqual({ minPreviousStreak: 5, perMonth: 2 });
  });
});
