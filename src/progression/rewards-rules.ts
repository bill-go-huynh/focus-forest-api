import type { TreeStage } from '../trees/tree-stages.js';
import { acquirableAt, type Acquisition, type CosmeticType } from './progression-rules.js';

/**
 * Species selection and equipment rules (A4.3; docs/03_TREE_SYSTEM.md §9–10). A species is a
 * visual definition of the same tree: it changes nothing the tree earns. Cosmetics decorate the
 * garden; focus grows the tree. Pure.
 */

export type SpeciesSelectionCheck =
  | { ok: true }
  | { ok: false; reason: 'species_not_owned' | 'species_not_selectable' | 'species_locked' };

/**
 * Whether the current month's tree can take this species now: owned, acquirable as a definition
 * (active, inside its window), and the tree still a growing Seed. The first counted session
 * always reaches Sprout, so the species is frozen by it, and an archived tree never changes.
 */
export function checkSpeciesSelection(
  input: {
    tree: { status: 'growing' | 'archived'; stage: TreeStage };
    species: Acquisition | null;
    owned: boolean;
  },
  now: Date,
): SpeciesSelectionCheck {
  if (!input.species || !input.owned) return { ok: false, reason: 'species_not_owned' };
  if (input.species.status !== 'active' || !acquirableAt(input.species, now).acquirable) {
    return { ok: false, reason: 'species_not_selectable' };
  }
  if (input.tree.status !== 'growing' || input.tree.stage !== 'seed') {
    return { ok: false, reason: 'species_locked' };
  }
  return { ok: true };
}

/**
 * One exclusive slot per cosmetic type: the forest's scene slots, and the profile frame, which
 * belongs to the profile only. A semantic set, never free-form keys.
 */
export const FOREST_SLOTS = ['background', 'decoration', 'fauna', 'weather', 'effect'] as const;
export const EQUIPMENT_SLOTS = [...FOREST_SLOTS, 'profile_frame'] as const;
export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];
export type ForestSlot = (typeof FOREST_SLOTS)[number];

export function isEquipmentSlot(value: string): value is EquipmentSlot {
  return EQUIPMENT_SLOTS.some((slot) => slot === value);
}

export type EquipCheck =
  { ok: true } | { ok: false; reason: 'cosmetic_not_owned' | 'cosmetic_wrong_slot' };

/**
 * Whether a cosmetic can go into a slot: owned (availability does not matter once owned) and of
 * the slot's type.
 */
export function checkEquip(
  slot: EquipmentSlot,
  cosmetic: { type: CosmeticType } | null,
  owned: boolean,
): EquipCheck {
  if (!cosmetic || !owned) return { ok: false, reason: 'cosmetic_not_owned' };
  if (cosmetic.type !== slot) return { ok: false, reason: 'cosmetic_wrong_slot' };
  return { ok: true };
}
