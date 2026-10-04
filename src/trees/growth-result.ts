import type { GrowthResultDto } from './tree.contracts.js';
import { TREE_STAGES } from './tree-stages.js';
import { VITALITY_STATES } from './vitality.js';

/**
 * Checks a growth result at the storage boundary: before it is written to a session, and when
 * it is read back for a replay. Throws on anything that is not a GrowthResultDto.
 */
export function parseGrowthResult(value: unknown): GrowthResultDto {
  const fail = (why: string): never => {
    throw new Error(`Invalid growth result: ${why}.`);
  };
  if (!isObject(value)) return fail('not an object');
  if (typeof value['counted'] !== 'boolean') fail('counted must be a boolean');
  if (typeof value['monthClosed'] !== 'boolean') fail('monthClosed must be a boolean');

  if (value['stage'] !== undefined && !isChange(value['stage'], isStage)) fail('bad stage change');
  for (const key of ['fullness', 'blossoms', 'richness']) {
    if (value[key] !== undefined && !isChange(value[key], isLevel)) fail(`bad ${key} change`);
  }
  const newTraits = value['newTraits'];
  if (!Array.isArray(newTraits) || !newTraits.every(isTrait)) fail('bad newTraits');
  if (value['tree'] !== null && !isTreeState(value['tree'])) fail('bad tree');

  const changed =
    ['stage', 'fullness', 'blossoms', 'richness'].some((key) => value[key] !== undefined) ||
    (newTraits as unknown[]).length > 0;
  if (changed && value['counted'] !== true) fail('a session that does not count changed the tree');
  return value as unknown as GrowthResultDto;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isStage = (value: unknown) => TREE_STAGES.some((stage) => stage === value);
const isLevel = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
const isString = (value: unknown): value is string => typeof value === 'string';

function isChange(value: unknown, isValue: (value: unknown) => boolean): boolean {
  return isObject(value) && isValue(value['from']) && isValue(value['to']);
}

function isTrait(value: unknown): boolean {
  return isObject(value) && isString(value['id']) && isString(value['earnedAt']);
}

function isLevelBox(value: unknown, level: string, max: string): boolean {
  return isObject(value) && isLevel(value[level]) && isLevel(value[max]);
}

function isTreeState(value: unknown): boolean {
  if (!isObject(value)) return false;
  const progress = value['progress'];
  return (
    Number.isInteger(value['year']) &&
    Number.isInteger(value['month']) &&
    (value['status'] === 'growing' || value['status'] === 'archived') &&
    isString(value['species']) &&
    isLevel(value['variationSeed']) &&
    typeof value['partialFirstMonth'] === 'boolean' &&
    isLevel(value['configVersion']) &&
    Array.isArray(value['traits']) &&
    value['traits'].every(isTrait) &&
    (value['vitality'] === null || VITALITY_STATES.some((state) => state === value['vitality'])) &&
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
