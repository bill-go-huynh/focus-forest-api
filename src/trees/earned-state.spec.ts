import { HOUR, rulesWith, spread } from '../../test/support/tree-testing.js';
import { mergeEarned, type EarnedTreeState } from './earned-state.js';
import { computeTreeGrowth } from './tree-growth.js';

const earned = (overrides: Partial<EarnedTreeState> = {}): EarnedTreeState => ({
  stage: 'seed',
  fullnessLevel: 0,
  blossomLevel: 0,
  richnessTier: 0,
  traitIds: [],
  ...overrides,
});

describe('earned (permanent) tree state', () => {
  it('starts from a Seed with nothing earned', () => {
    const computed = earned({ stage: 'sprout', fullnessLevel: 1 });
    expect(mergeEarned(null, computed)).toEqual({
      earned: computed,
      changes: {
        stage: { from: 'seed', to: 'sprout' },
        fullness: { from: 0, to: 1 },
        newTraitIds: [],
      },
    });
  });

  it('never decreases: lower computed values keep what was earned', () => {
    const previous = earned({
      stage: 'final_form',
      fullnessLevel: 4,
      blossomLevel: 5,
      richnessTier: 2,
      traitIds: ['monthly-focus-hours:10'],
    });
    expect(mergeEarned(previous, earned())).toEqual({
      earned: previous,
      changes: { newTraitIds: [] },
    });
  });

  it('raises each dimension on its own', () => {
    const previous = earned({ stage: 'mature_tree', fullnessLevel: 4, blossomLevel: 2 });
    const computed = earned({ stage: 'blooming_tree', fullnessLevel: 3, blossomLevel: 3 });
    expect(mergeEarned(previous, computed)).toEqual({
      earned: earned({ stage: 'blooming_tree', fullnessLevel: 4, blossomLevel: 3 }),
      changes: {
        stage: { from: 'mature_tree', to: 'blooming_tree' },
        blossoms: { from: 2, to: 3 },
        newTraitIds: [],
      },
    });
  });

  it('keeps every earned trait and reports only new ones, in a stable order', () => {
    const previous = earned({ traitIds: ['streak-days:3', 'monthly-focus-hours:10'] });
    const computed = earned({ traitIds: ['monthly-focus-hours:25', 'monthly-focus-hours:10'] });
    const { earned: merged, changes } = mergeEarned(previous, computed);
    expect(merged.traitIds).toEqual([
      'streak-days:3',
      'monthly-focus-hours:10',
      'monthly-focus-hours:25',
    ]);
    expect(changes.newTraitIds).toEqual(['monthly-focus-hours:25']);
  });

  it('keeps a Final Form tree when stricter thresholds are configured mid-month', () => {
    const month = {
      month: { year: 2026, month: 9 },
      joinedOn: '2026-01-01',
      days: spread(34 * HOUR, '2026-09-01'),
      goalCompletions: { daily: 10, weekly: 0 },
      restDates: [],
    };
    const before = computeTreeGrowth(month, rulesWith());
    const after = computeTreeGrowth(
      month,
      rulesWith({
        'growth.stageThresholds': [600, 1200, 2400, 3600, 6000],
        'growth.blossomThresholds': [20, 40],
      }),
    );
    expect(before.stage).toBe('final_form');
    expect(after.stage).toBe('growing_tree');

    const { earned: kept, changes } = mergeEarned(before, after);
    expect(kept.stage).toBe('final_form');
    expect(kept.richnessTier).toBe(before.richnessTier);
    expect(kept.blossomLevel).toBe(before.blossomLevel);
    expect(changes).toEqual({ newTraitIds: [] });
  });
});
