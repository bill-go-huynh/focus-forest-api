import type { ProductConfig } from '../product-config/product-config.js';
import type { ProductConfigRegistry } from '../product-config/product-config.registry.js';

const MINUTE_MS = 60_000;

/**
 * The tree growth rules of one configuration version, in exact units (milliseconds, whole
 * percents). The growth engine takes these as input and never reads configuration itself.
 */
export interface GrowthRules {
  configVersion: number;
  /** Cumulative growth for Young Tree, Growing Tree, Mature Tree, Blooming Tree, Final Form. */
  stageThresholdsMs: readonly number[];
  dailySoftCapMs: number;
  overCapPercent: number;
  firstMonthFloorPercent: number;
  fullness: {
    activeDaysWeight: number;
    weeklyConsistencyWeight: number;
    targetActiveDays: number;
    activeDaysPerWeek: number;
    levelPercents: readonly number[];
  };
  blossoms: {
    dailyGoalPoints: number;
    weeklyGoalPoints: number;
    levelThresholds: readonly number[];
  };
  /** Growth beyond Final Form at which each richness tier begins. */
  richnessTiersMs: readonly number[];
  focusHourMilestones: readonly number[];
}

export interface VitalityRules {
  thrivingActiveRunDays: number;
  healthyWithinDays: number;
  stableWithinDays: number;
  /** Thriving also when the daily goal was met on goalMetDaysRequired of the last goalWindowDays. */
  goalWindowDays: number;
  goalMetDaysRequired: number;
}

type Config = ProductConfig<ProductConfigRegistry>;

export function growthRulesFrom(config: Config): GrowthRules {
  const weights = config.get('growth.fullnessWeights');
  const targets = config.get('growth.fullnessTargets');
  const points = config.get('growth.blossomPoints');
  return {
    configVersion: config.version,
    stageThresholdsMs: config.get('growth.stageThresholds').map((minutes) => minutes * MINUTE_MS),
    dailySoftCapMs: config.get('growth.dailySoftCap') * MINUTE_MS,
    overCapPercent: config.get('growth.overCapRate'),
    firstMonthFloorPercent: config.get('growth.firstMonthProration').floorPercent,
    fullness: {
      activeDaysWeight: weights.activeDays,
      weeklyConsistencyWeight: weights.weeklyConsistency,
      targetActiveDays: targets.activeDays,
      activeDaysPerWeek: targets.activeDaysPerWeek,
      levelPercents: [...config.get('growth.fullnessLevels')],
    },
    blossoms: {
      dailyGoalPoints: points.dailyGoal,
      weeklyGoalPoints: points.weeklyGoal,
      levelThresholds: [...config.get('growth.blossomThresholds')],
    },
    richnessTiersMs: config.get('growth.richnessTiers').map((minutes) => minutes * MINUTE_MS),
    focusHourMilestones: [...config.get('growth.focusHourMilestones')],
  };
}

export function vitalityRulesFrom(config: Config): VitalityRules {
  const rules = config.get('vitality.rules');
  const goals = config.get('vitality.goalConsistency');
  return {
    thrivingActiveRunDays: rules.thrivingActiveRunDays,
    healthyWithinDays: rules.healthyWithinDays,
    stableWithinDays: rules.stableWithinDays,
    goalWindowDays: goals.windowDays,
    goalMetDaysRequired: goals.metDaysRequired,
  };
}
