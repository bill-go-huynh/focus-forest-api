import { parseProgressionResult } from './achievement-evaluation.js';
import {
  EQUIPMENT_SLOTS,
  FOREST_SLOTS,
  checkEquip,
  checkSpeciesSelection,
  isEquipmentSlot,
} from './rewards-rules.js';

const now = new Date('2026-10-10T12:00:00.000Z');
const active = {
  status: 'active' as const,
  source: 'achievement' as const,
  availability: 'permanent' as const,
  availableFrom: null,
  availableUntil: null,
};

describe('species selection: the current month, while its tree is a Seed', () => {
  const seed = { status: 'growing' as const, stage: 'seed' as const };

  it('allows an owned, active species on a growing Seed', () => {
    expect(checkSpeciesSelection({ tree: seed, species: active, owned: true }, now)).toEqual({
      ok: true,
    });
    expect(
      checkSpeciesSelection(
        { tree: seed, species: { ...active, source: 'system' }, owned: true },
        now,
      ),
    ).toEqual({ ok: true });
  });

  it('refuses a species the user does not own, or that does not exist', () => {
    expect(checkSpeciesSelection({ tree: seed, species: active, owned: false }, now)).toEqual({
      ok: false,
      reason: 'species_not_owned',
    });
    expect(checkSpeciesSelection({ tree: seed, species: null, owned: false }, now)).toEqual({
      ok: false,
      reason: 'species_not_owned',
    });
  });

  it('refuses a planned or retired species even when owned', () => {
    for (const status of ['planned', 'retired'] as const) {
      expect(
        checkSpeciesSelection({ tree: seed, species: { ...active, status }, owned: true }, now),
      ).toEqual({ ok: false, reason: 'species_not_selectable' });
    }
  });

  it('is locked from Sprout on, and on an archived tree', () => {
    for (const tree of [
      { status: 'growing' as const, stage: 'sprout' as const },
      { status: 'growing' as const, stage: 'final_form' as const },
      { status: 'archived' as const, stage: 'seed' as const },
    ]) {
      expect(checkSpeciesSelection({ tree, species: active, owned: true }, now)).toEqual({
        ok: false,
        reason: 'species_locked',
      });
    }
  });
});

describe('equipment slots: one per cosmetic type, the frame on the profile', () => {
  it('are the cosmetic types, the forest ones apart from the profile frame', () => {
    expect(EQUIPMENT_SLOTS).toEqual([
      'background',
      'decoration',
      'fauna',
      'weather',
      'effect',
      'profile_frame',
    ]);
    expect(FOREST_SLOTS).not.toContain('profile_frame');
    expect(isEquipmentSlot('decoration')).toBe(true);
    expect(isEquipmentSlot('hat')).toBe(false);
  });

  it('take an owned cosmetic of their own type only', () => {
    const lantern = { type: 'decoration' as const };
    expect(checkEquip('decoration', lantern, true)).toEqual({ ok: true });
    expect(checkEquip('background', lantern, true)).toEqual({
      ok: false,
      reason: 'cosmetic_wrong_slot',
    });
    expect(checkEquip('decoration', lantern, false)).toEqual({
      ok: false,
      reason: 'cosmetic_not_owned',
    });
    expect(checkEquip('decoration', null, false)).toEqual({
      ok: false,
      reason: 'cosmetic_not_owned',
    });
  });
});

describe('the progression result with rewards (A4.3)', () => {
  it('holds the species and cosmetics the action unlocked', () => {
    const result = {
      newlyEarnedBadgeIds: ['first-session'],
      newlyUnlockedSpeciesIds: ['oak'],
      newlyUnlockedCosmeticIds: [],
    };
    expect(parseProgressionResult(result)).toEqual(result);
  });

  it('reads a result stored before A4.3 as unlocking no reward', () => {
    expect(parseProgressionResult({ newlyEarnedBadgeIds: ['first-session'] })).toEqual({
      newlyEarnedBadgeIds: ['first-session'],
      newlyUnlockedSpeciesIds: [],
      newlyUnlockedCosmeticIds: [],
    });
  });

  it('refuses rewards that are not stable ids', () => {
    expect(() =>
      parseProgressionResult({ newlyEarnedBadgeIds: [], newlyUnlockedSpeciesIds: ['Oak Tree'] }),
    ).toThrow(/progression result/i);
  });
});
