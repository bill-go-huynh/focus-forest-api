import { findConfigProblems } from './config-types.js';
import { productConfigRegistry } from './product-config.registry.js';

const sessionValues = { 'session.minValidMinutes': 5, 'session.maxPauseMinutes': 30 };

describe('production registry', () => {
  it('defines the Phase 2 session rules and no other keys yet', () => {
    expect(Object.keys(productConfigRegistry).sort()).toEqual([
      'session.maxPauseMinutes',
      'session.minValidMinutes',
    ]);
  });

  it('accepts whole minutes of at least 1', () => {
    expect(findConfigProblems(productConfigRegistry, sessionValues)).toEqual([]);
    expect(
      findConfigProblems(productConfigRegistry, {
        'session.minValidMinutes': 1,
        'session.maxPauseMinutes': 1,
      }),
    ).toEqual([]);
  });

  describe.each(['session.minValidMinutes', 'session.maxPauseMinutes'] as const)('%s', (key) => {
    it.each([0, -5, 2.5, '5', null])('rejects %s', (value) => {
      const problems = findConfigProblems(productConfigRegistry, {
        ...sessionValues,
        [key]: value,
      });
      expect(problems).toEqual([expect.stringContaining(`"${key}" must be an integer ≥ 1`)]);
    });
  });
});
