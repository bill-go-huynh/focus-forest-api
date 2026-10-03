/** The seven growth stages, in order (docs/03_TREE_SYSTEM.md §3). Machine identifiers, not labels. */
export const TREE_STAGES = [
  'seed',
  'sprout',
  'young_tree',
  'growing_tree',
  'mature_tree',
  'blooming_tree',
  'final_form',
] as const;

export type TreeStage = (typeof TREE_STAGES)[number];

/** 1 (Seed) to 7 (Final Form). */
export function stageNumber(stage: TreeStage): number {
  return TREE_STAGES.indexOf(stage) + 1;
}

export function laterStage(a: TreeStage, b: TreeStage): TreeStage {
  return stageNumber(a) >= stageNumber(b) ? a : b;
}
