import { isLevel, isObject, isProgress, isStage, isString, isTrait } from './json-checks.js';
import type { GrowthResultDto } from './tree.contracts.js';
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
  // A session of a closed month never grows a tree, and no tree is shown for it.
  if (value['monthClosed'] === true && (changed || value['tree'] !== null)) {
    fail('a closed month changed or showed a tree');
  }
  return value as unknown as GrowthResultDto;
}

function isChange(value: unknown, isValue: (value: unknown) => boolean): boolean {
  return isObject(value) && isValue(value['from']) && isValue(value['to']);
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
    isProgress(progress)
  );
}

/** A session of a closed month is kept, but grows nothing and shows no tree (A3.4). */
export function closedMonthGrowth(counted: boolean): GrowthResultDto {
  return parseGrowthResult({ counted, monthClosed: true, newTraits: [], tree: null });
}
