import { laterStage, type TreeStage } from './tree-stages.js';

/**
 * The permanent dimensions of a monthly tree (docs/06_DOMAIN_MODEL.md → TreeProgress): stage,
 * fullness, blossoms, richness, and traits only move up. Vitality is not part of this state.
 */
export interface EarnedTreeState {
  stage: TreeStage;
  fullnessLevel: number;
  blossomLevel: number;
  richnessTier: number;
  traitIds: readonly string[];
}

export interface EarnedChanges {
  stage?: { from: TreeStage; to: TreeStage };
  fullness?: { from: number; to: number };
  blossoms?: { from: number; to: number };
  richness?: { from: number; to: number };
  /** Traits earned by this merge, in the order they were computed. */
  newTraitIds: string[];
}

const NOTHING_EARNED: EarnedTreeState = {
  stage: 'seed',
  fullnessLevel: 0,
  blossomLevel: 0,
  richnessTier: 0,
  traitIds: [],
};

/**
 * Combines what a tree had earned with a fresh computation: each dimension keeps its maximum and
 * traits accumulate. A recomputation with stricter configuration therefore never shrinks a tree.
 * `previous` is null for a tree with no stored state yet.
 */
export function mergeEarned(
  previous: EarnedTreeState | null,
  computed: EarnedTreeState,
): { earned: EarnedTreeState; changes: EarnedChanges } {
  const before = previous ?? NOTHING_EARNED;
  const newTraitIds = computed.traitIds.filter((id) => !before.traitIds.includes(id));
  const earned: EarnedTreeState = {
    stage: laterStage(before.stage, computed.stage),
    fullnessLevel: Math.max(before.fullnessLevel, computed.fullnessLevel),
    blossomLevel: Math.max(before.blossomLevel, computed.blossomLevel),
    richnessTier: Math.max(before.richnessTier, computed.richnessTier),
    traitIds: [...before.traitIds, ...newTraitIds],
  };

  const changes: EarnedChanges = { newTraitIds };
  if (earned.stage !== before.stage) changes.stage = { from: before.stage, to: earned.stage };
  if (earned.fullnessLevel !== before.fullnessLevel) {
    changes.fullness = { from: before.fullnessLevel, to: earned.fullnessLevel };
  }
  if (earned.blossomLevel !== before.blossomLevel) {
    changes.blossoms = { from: before.blossomLevel, to: earned.blossomLevel };
  }
  if (earned.richnessTier !== before.richnessTier) {
    changes.richness = { from: before.richnessTier, to: earned.richnessTier };
  }
  return { earned, changes };
}
