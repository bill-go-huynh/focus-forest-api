import { focusHourTraitId, parseTraitId, streakTraitId, TRAIT_KINDS } from './traits.js';

describe('trait identifiers', () => {
  it('names monthly focus-hour and streak milestones', () => {
    expect(focusHourTraitId(10)).toBe('monthly-focus-hours:10');
    expect(streakTraitId(7)).toBe('streak-days:7');
    expect(TRAIT_KINDS).toEqual(['monthly-focus-hours', 'streak-days']);
  });

  it('reads known identifiers back', () => {
    expect(parseTraitId('monthly-focus-hours:25')).toEqual({
      kind: 'monthly-focus-hours',
      value: 25,
    });
    expect(parseTraitId('streak-days:3')).toEqual({ kind: 'streak-days', value: 3 });
  });

  it('keeps unknown or future identifiers as they are', () => {
    expect(parseTraitId('lantern:2027')).toEqual({
      kind: 'unknown',
      id: 'lantern:2027',
    });
    expect(parseTraitId('monthly-focus-hours:many')).toEqual({
      kind: 'unknown',
      id: 'monthly-focus-hours:many',
    });
  });
});
