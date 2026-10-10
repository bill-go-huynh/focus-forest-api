import { boolean, increasingList, integer, list, oneOf, shape, slug } from './config-types.js';

describe('config value types', () => {
  it('integer accepts integers within its bounds', () => {
    const minutes = integer({ min: 1, max: 600 });
    expect(minutes.is(5)).toBe(true);
    expect(minutes.is(1)).toBe(true);
    expect(minutes.is(600)).toBe(true);
  });

  it.each([0, 601, 2.5, '5', null, undefined, Number.NaN])('integer rejects %s', (value) => {
    expect(integer({ min: 1, max: 600 }).is(value)).toBe(false);
  });

  it('integer describes what it expects', () => {
    expect(integer({ min: 1 }).expected).toBe('an integer ≥ 1');
    expect(integer({ min: 1, max: 600 }).expected).toBe('an integer from 1 to 600');
    expect(integer().expected).toBe('an integer');
  });

  it('boolean accepts only booleans', () => {
    expect(boolean().is(true)).toBe(true);
    expect(boolean().is(false)).toBe(true);
    expect(boolean().is('true')).toBe(false);
    expect(boolean().is(1)).toBe(false);
  });

  it('list checks every item', () => {
    const days = list(integer({ min: 1 }));
    expect(days.is([3, 7, 14])).toBe(true);
    expect(days.is([])).toBe(true);
    expect(days.is([3, 0])).toBe(false);
    expect(days.is('3,7')).toBe(false);
    expect(days.expected).toBe('a list of an integer ≥ 1');
  });

  describe('increasingList', () => {
    const thresholds = increasingList(integer({ min: 1 }), { length: 3 });

    it('accepts strictly increasing items of the right count', () => {
      expect(thresholds.is([120, 360, 720])).toBe(true);
    });

    it.each([
      [[120, 120, 720]],
      [[360, 120, 720]],
      [[120, 360]],
      [[120, 360, 720, 1200]],
      [[0, 360, 720]],
      ['120,360,720'],
    ])('rejects %j', (value) => {
      expect(thresholds.is(value)).toBe(false);
    });

    it('accepts a count within bounds when no exact length is set', () => {
      const tiers = increasingList(integer({ min: 1 }), { minLength: 1, maxLength: 2 });
      expect(tiers.is([3])).toBe(true);
      expect(tiers.is([])).toBe(false);
      expect(tiers.is([1, 2, 3])).toBe(false);
    });

    it('describes what it expects', () => {
      expect(thresholds.expected).toBe('a strictly increasing list of 3 × an integer ≥ 1');
      expect(increasingList(integer({ min: 1 }), { minLength: 1, maxLength: 9 }).expected).toBe(
        'a strictly increasing list of 1 to 9 × an integer ≥ 1',
      );
    });
  });

  describe('shape', () => {
    const weights = shape(
      {
        activeDays: integer({ min: 0, max: 100 }),
        weeklyConsistency: integer({ min: 0, max: 100 }),
      },
      {
        expected: 'weights adding up to 100',
        holds: (value) => value.activeDays + value.weeklyConsistency === 100,
      },
    );

    it('accepts an object with exactly its fields, valid, and the rule holding', () => {
      expect(weights.is({ activeDays: 60, weeklyConsistency: 40 })).toBe(true);
    });

    it.each([
      [{ activeDays: 60 }],
      [{ activeDays: 60, weeklyConsistency: 40, extra: 1 }],
      [{ activeDays: 60, weeklyConsistency: '40' }],
      [{ activeDays: 70, weeklyConsistency: 40 }],
      [[60, 40]],
      [null],
    ])('rejects %j', (value) => {
      expect(weights.is(value)).toBe(false);
    });

    it('describes its fields and its rule', () => {
      expect(weights.expected).toBe(
        'an object { activeDays: an integer from 0 to 100, weeklyConsistency: an integer from 0 to 100 } with weights adding up to 100',
      );
      expect(shape({ floorPercent: integer({ min: 1, max: 100 }) }).expected).toBe(
        'an object { floorPercent: an integer from 1 to 100 }',
      );
    });
  });

  describe('oneOf (A5.5)', () => {
    const kind = oneOf(['personal', 'friend']);
    it('accepts only the listed strings', () => {
      expect(kind.is('personal')).toBe(true);
      expect(kind.is('group')).toBe(false);
      expect(kind.is(1)).toBe(false);
      expect(kind.expected).toBe('one of "personal", "friend"');
    });
  });

  describe('slug (A5.5)', () => {
    it('accepts lowercase words joined by hyphens', () => {
      expect(slug().is('seven-days')).toBe(true);
      expect(slug().is('ten-hours-1')).toBe(true);
      for (const value of ['Seven', 'seven_days', '-a', 'a-', '', 'a--b', 5]) {
        expect(slug().is(value)).toBe(false);
      }
    });
  });
});
