import { day, HOUR, rulesWith, spread } from '../../test/support/tree-testing.js';
import type { DayFocus } from '../focus-stats/focus-stats.js';
import { mergeEarned } from './earned-state.js';
import { toTreeProgress } from './tree.contracts.js';
import { computeTreeGrowth } from './tree-growth.js';

const rules = rulesWith();

function progressOf(days: readonly DayFocus[], joinedOn = '2026-01-01', withRules = rules) {
  const growth = computeTreeGrowth(
    {
      month: { year: 2026, month: 9 },
      joinedOn,
      days,
      goalCompletions: { daily: 3, weekly: 0 },
      restDates: [],
    },
    withRules,
  );
  return toTreeProgress(mergeEarned(null, growth).earned, growth, withRules);
}

describe('TreeProgress contract', () => {
  it('describes a Seed', () => {
    expect(progressOf([])).toEqual({
      stage: 'seed',
      stageNumber: 1,
      progressToNextStage: 0,
      growthMinutes: 0,
      fullness: { level: 0, maxLevel: 5 },
      blossoms: { level: 2, maxLevel: 7 },
      richness: { tier: 0, maxTier: 5 },
    });
  });

  it('gives progress within the current stage, from 0 to 1', () => {
    expect(progressOf([day('2026-09-02', 60)]).progressToNextStage).toBe(0.5); // Sprout → 2 h
    expect(progressOf(spread(4 * HOUR, '2026-09-01')).progressToNextStage).toBe(0.5); // 2 → 6 h
    expect(progressOf([day('2026-09-02', 40)]).progressToNextStage).toBe(0.333);
  });

  it('has no next stage at Final Form', () => {
    const progress = progressOf(spread(31 * HOUR, '2026-09-01'));
    expect(progress.stage).toBe('final_form');
    expect(progress.stageNumber).toBe(7);
    expect(progress.progressToNextStage).toBeNull();
    expect(progress.growthMinutes).toBe(31 * 60);
  });

  it('measures progress against the prorated thresholds of a partial first month', () => {
    // Joined on the 16th: Young Tree at 1 h.
    expect(progressOf([day('2026-09-16', 30)], '2026-09-16').progressToNextStage).toBe(0.5);
  });

  it('shows an earned stage above the recomputed one with no progress yet', () => {
    const growth = computeTreeGrowth(
      {
        month: { year: 2026, month: 9 },
        joinedOn: '2026-01-01',
        days: [day('2026-09-02', 60)],
        goalCompletions: { daily: 0, weekly: 0 },
        restDates: [],
      },
      rules,
    );
    const earned = { ...mergeEarned(null, growth).earned, stage: 'mature_tree' as const };
    expect(toTreeProgress(earned, growth, rules)).toMatchObject({
      stage: 'mature_tree',
      stageNumber: 5,
      progressToNextStage: 0,
    });
  });

  it('takes the level ceilings from the configuration', () => {
    const progress = progressOf(
      [],
      undefined,
      rulesWith({ 'growth.fullnessLevels': [50], 'growth.richnessTiers': [60, 120] }),
    );
    expect(progress.fullness.maxLevel).toBe(1);
    expect(progress.richness.maxTier).toBe(2);
  });
});
