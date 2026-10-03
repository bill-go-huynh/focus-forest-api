import type { EarnedTreeState } from './earned-state.js';
import type { GrowthRules } from './growth-rules.js';
import type { TreeGrowth } from './tree-growth.js';
import { stageNumber, type TreeStage } from './tree-stages.js';
import type { VitalityState } from './vitality.js';

/**
 * Phase 3 API contracts for the monthly tree (docs/03_TREE_SYSTEM.md §14, docs/07). These are
 * the JSON shapes the mobile client builds against. They carry product truth only: no
 * positions, colors, durations, or other presentation. Fields may be added later; existing
 * fields keep their meaning. Endpoints that return them arrive with A3.3 (current tree, session
 * growth) and A3.4 (archived trees).
 */

export type { TreeStage, VitalityState };

export interface LevelDto {
  level: number;
  /** The highest level the configuration defines: the renderer scales between 0 and this. */
  maxLevel: number;
}

export interface TreeProgressDto {
  stage: TreeStage;
  /** 1 (Seed) to 7 (Final Form). */
  stageNumber: number;
  /** 0 to 1 within the current stage, in thousandths; null at Final Form. */
  progressToNextStage: number | null;
  /** Growth after the daily soft cap, in whole minutes. */
  growthMinutes: number;
  fullness: LevelDto;
  blossoms: LevelDto;
  richness: { tier: number; maxTier: number };
}

export interface TreeTraitDto {
  /** A stable identifier such as "monthly-focus-hours:10". Clients ignore unknown ones. */
  id: string;
  /** ISO 8601. */
  earnedAt: string;
}

export interface TreeStateDto {
  year: number;
  month: number;
  status: 'growing' | 'archived';
  /** The signature species until more species arrive (Phase 4 Progression). */
  species: string;
  /** Unsigned 32-bit integer. */
  variationSeed: number;
  partialFirstMonth: boolean;
  /** The configuration version the progress was computed with (frozen when archived). */
  configVersion: number;
  progress: TreeProgressDto;
  traits: TreeTraitDto[];
  /** Null for an archived tree, which always renders "at rest". */
  vitality: VitalityState | null;
}

/**
 * What one submitted session did to its month's tree, so the client knows what to celebrate.
 * Stored with the session, so a replayed submission returns the same result.
 */
export interface GrowthResultDto {
  /** Whether the session counts (not discarded). A discarded session changes nothing. */
  counted: boolean;
  /**
   * The session's month was already archived when it arrived: the session is kept in history
   * and statistics, but the archived tree and recap do not change.
   */
  monthClosed: boolean;
  stage?: { from: TreeStage; to: TreeStage };
  fullness?: { from: number; to: number };
  blossoms?: { from: number; to: number };
  richness?: { from: number; to: number };
  newTraits: TreeTraitDto[];
  /** The tree after the session; null when the month was already closed. */
  tree: TreeStateDto | null;
}

/** The progress part of the contract, for the earned state and the computation behind it. */
export function toTreeProgress(
  earned: EarnedTreeState,
  growth: Pick<TreeGrowth, 'growthMilliseconds' | 'stageThresholdsMs'>,
  rules: GrowthRules,
): TreeProgressDto {
  return {
    stage: earned.stage,
    stageNumber: stageNumber(earned.stage),
    progressToNextStage: progressToNextStage(earned.stage, growth),
    growthMinutes: Math.floor(growth.growthMilliseconds / 60_000),
    fullness: { level: earned.fullnessLevel, maxLevel: rules.fullness.levelPercents.length },
    blossoms: { level: earned.blossomLevel, maxLevel: rules.blossoms.levelThresholds.length },
    richness: { tier: earned.richnessTier, maxTier: rules.richnessTiersMs.length },
  };
}

/**
 * Progress from the start of the earned stage to the next one. Seed advances with the first
 * session, so it shows 0. An earned stage above what the growth now reaches shows 0.
 */
function progressToNextStage(
  stage: TreeStage,
  growth: Pick<TreeGrowth, 'growthMilliseconds' | 'stageThresholdsMs'>,
): number | null {
  if (stage === 'final_form') return null;
  if (stage === 'seed') return 0;
  // Sprout starts at 0; Young Tree at the first threshold, and so on.
  const index = stageNumber(stage) - 2;
  const start = index === 0 ? 0 : (growth.stageThresholdsMs[index - 1] ?? 0);
  const next = growth.stageThresholdsMs[index] ?? start;
  if (next <= start) return 0;
  const share = (growth.growthMilliseconds - start) / (next - start);
  return Math.floor(Math.min(1, Math.max(0, share)) * 1000) / 1000;
}
