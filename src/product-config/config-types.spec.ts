import { boolean, integer, list } from './config-types.js';

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
});
