import { TREE_STAGES } from './tree-stages.js';

/** Checks for tree JSON read back from storage (growth results, archives, recaps). */

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const isString = (value: unknown): value is string => typeof value === 'string';
export const isStage = (value: unknown) => TREE_STAGES.some((stage) => stage === value);
export const isLevel = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
export const isLocalDate = (value: unknown) => isString(value) && /^\d{4}-\d{2}-\d{2}$/.test(value);

export function isTrait(value: unknown): boolean {
  return isObject(value) && isString(value['id']) && isString(value['earnedAt']);
}

function isLevelBox(value: unknown, level: string, max: string): boolean {
  return isObject(value) && isLevel(value[level]) && isLevel(value[max]);
}

export function isProgress(progress: unknown): boolean {
  return (
    isObject(progress) &&
    isStage(progress['stage']) &&
    isLevel(progress['stageNumber']) &&
    (progress['progressToNextStage'] === null ||
      typeof progress['progressToNextStage'] === 'number') &&
    isLevel(progress['growthMinutes']) &&
    isLevelBox(progress['fullness'], 'level', 'maxLevel') &&
    isLevelBox(progress['blossoms'], 'level', 'maxLevel') &&
    isLevelBox(progress['richness'], 'tier', 'maxTier')
  );
}
