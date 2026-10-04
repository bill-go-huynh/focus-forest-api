import { parseGrowthResult } from './growth-result.js';
import type { GrowthResultDto, TreeStateDto } from './tree.contracts.js';

const tree: TreeStateDto = {
  year: 2026,
  month: 10,
  status: 'growing',
  species: 'signature',
  variationSeed: 3_078_237_722,
  partialFirstMonth: false,
  configVersion: 3,
  progress: {
    stage: 'sprout',
    stageNumber: 2,
    progressToNextStage: 0.041,
    growthMinutes: 5,
    fullness: { level: 0, maxLevel: 5 },
    blossoms: { level: 0, maxLevel: 7 },
    richness: { tier: 0, maxTier: 5 },
  },
  traits: [{ id: 'streak-days:3', earnedAt: '2026-10-07T20:00:00.000Z' }],
  vitality: 'healthy',
};

const counted: GrowthResultDto = {
  counted: true,
  monthClosed: false,
  stage: { from: 'seed', to: 'sprout' },
  newTraits: [],
  tree,
};

describe('stored growth results', () => {
  it('accepts a complete result, unchanged', () => {
    expect(parseGrowthResult(counted)).toEqual(counted);
    const discarded = { counted: false, monthClosed: false, newTraits: [], tree };
    expect(parseGrowthResult(discarded)).toEqual(discarded);
    expect(parseGrowthResult({ ...discarded, monthClosed: true, tree: null })).toEqual({
      ...discarded,
      monthClosed: true,
      tree: null,
    });
  });

  it.each([
    ['not an object', 'growth'],
    ['no counted flag', { ...counted, counted: undefined }],
    ['an unknown stage', { ...counted, stage: { from: 'seed', to: 'oak' } }],
    ['a level change that is not numbers', { ...counted, fullness: { from: '0', to: 1 } }],
    ['traits that are not a list', { ...counted, newTraits: 'streak-days:3' }],
    ['a trait without a time', { ...counted, newTraits: [{ id: 'streak-days:3' }] }],
    ['a tree without progress', { ...counted, tree: { ...tree, progress: undefined } }],
    ['an unknown vitality', { ...counted, tree: { ...tree, vitality: 'wilting' } }],
    ['a changed growth without a counted session', { ...counted, counted: false }],
  ])('refuses %s', (_, value) => {
    expect(() => parseGrowthResult(value)).toThrow(/growth result/i);
  });
});
