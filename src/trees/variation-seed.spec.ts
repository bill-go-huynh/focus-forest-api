import { variationSeed } from './variation-seed.js';

const USER = '0192f1a2-3b4c-7d5e-8f60-718293a4b5c6';
const OTHER_USER = '0192f1a2-3b4c-7d5e-8f60-718293a4b5c7';

describe('variation seed', () => {
  it('is a fixed value for a tree, the same in every process and release', () => {
    // First 4 bytes of SHA-256("monthly-tree:<user>:2026-09"), computed independently.
    expect(variationSeed({ userId: USER, year: 2026, month: 9 })).toBe(3_078_237_722);
    expect(variationSeed({ userId: USER, year: 2026, month: 10 })).toBe(1_348_844_462);
  });

  it('differs between users, months, and years', () => {
    const seeds = new Set([
      variationSeed({ userId: USER, year: 2026, month: 9 }),
      variationSeed({ userId: OTHER_USER, year: 2026, month: 9 }),
      variationSeed({ userId: USER, year: 2026, month: 10 }),
      variationSeed({ userId: USER, year: 2027, month: 9 }),
    ]);
    expect(seeds.size).toBe(4);
  });

  it('is an unsigned 32-bit integer', () => {
    for (let month = 1; month <= 12; month += 1) {
      const seed = variationSeed({ userId: USER, year: 2026, month });
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 32);
    }
  });
});
