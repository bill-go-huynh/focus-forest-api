import { normalizeUsername, parseUsername, USERNAME_PATTERN } from './username.js';

describe('usernames (A5.1)', () => {
  it('normalizes to trimmed lowercase', () => {
    expect(normalizeUsername('  Ada_Lovelace ')).toBe('ada_lovelace');
  });

  it.each(['ada', 'ada_1815', 'a_b', '_ada_', 'x'.repeat(20), '123'])('accepts %s', (name) => {
    expect(parseUsername(name)).toEqual({ ok: true, username: name });
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'x'.repeat(21)],
    ['a hyphen', 'ada-l'],
    ['a dot', 'ada.l'],
    ['a space inside', 'ada l'],
    ['an accented letter', 'adà'],
    ['an emoji', 'ada🌱'],
    ['empty', '   '],
  ])('refuses %s as invalid', (_label, name) => {
    expect(parseUsername(name)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('accepts mixed case and surrounding spaces, stored lowercase', () => {
    expect(parseUsername(' Grace_H ')).toEqual({ ok: true, username: 'grace_h' });
  });

  it.each(['admin', 'Support', 'moderator', 'focusforest', 'focus_forest', 'staff', 'official'])(
    'refuses the reserved name %s',
    (name) => {
      expect(parseUsername(name)).toEqual({ ok: false, reason: 'reserved' });
    },
  );

  it('matches the database CHECK pattern', () => {
    expect(USERNAME_PATTERN).toBe('^[a-z0-9_]{3,20}$');
  });
});
