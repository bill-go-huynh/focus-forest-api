import { formatReactionTarget, parseReactionTarget, REACTIONS } from './reaction-target.js';

describe('reaction targets (A5.2)', () => {
  it('has the five spec §13.4 reactions, as stable ids', () => {
    expect(REACTIONS).toEqual(['fire', 'sprout', 'clap', 'heart', 'sparkles']);
  });

  it.each([
    ['forest', { type: 'forest', key: '' }],
    ['tree:2026-09', { type: 'tree', key: '2026-09', year: 2026, month: 9 }],
    ['tree:2026-12', { type: 'tree', key: '2026-12', year: 2026, month: 12 }],
    ['badge:first-session', { type: 'badge', key: 'first-session', badgeId: 'first-session' }],
    ['badge:streak:7', { type: 'badge', key: 'streak:7', badgeId: 'streak:7' }],
  ])('parses %s', (input, expected) => {
    expect(parseReactionTarget(input)).toEqual(expected);
  });

  it.each([
    '',
    'forest:',
    'Forest',
    'tree',
    'tree:',
    'tree:2026-9',
    'tree:2026-13',
    'tree:2026-00',
    'tree:1999-01',
    'tree:2026-09-01',
    'badge:',
    'badge:First',
    'badge:a b',
    `badge:${'a'.repeat(101)}`,
    'note:1',
  ])('refuses %j', (input) => {
    expect(parseReactionTarget(input)).toBeNull();
  });

  it('formats back to the same string', () => {
    for (const input of ['forest', 'tree:2026-09', 'badge:first-session']) {
      expect(formatReactionTarget(parseReactionTarget(input)!)).toBe(input);
    }
  });
});
