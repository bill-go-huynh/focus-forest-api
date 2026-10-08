import {
  canSee,
  PRIVACY_CATEGORIES,
  PRIVACY_DEFAULTS,
  relationOf,
  type PrivacyLevel,
  type Relation,
} from './visibility.js';

const LEVELS: PrivacyLevel[] = ['public', 'friends', 'private'];

describe('visibility policy (A5.1)', () => {
  describe('relationOf', () => {
    it('is self for the owner, whatever else is true', () => {
      expect(relationOf({ self: true, blocked: false, following: false, followedBy: false })).toBe(
        'self',
      );
    });

    it('is blocked when either side blocked the other', () => {
      expect(relationOf({ self: false, blocked: true, following: true, followedBy: true })).toBe(
        'blocked',
      );
    });

    it('is friend only for a mutual follow', () => {
      expect(relationOf({ self: false, blocked: false, following: true, followedBy: true })).toBe(
        'friend',
      );
      expect(relationOf({ self: false, blocked: false, following: true, followedBy: false })).toBe(
        'other',
      );
      expect(relationOf({ self: false, blocked: false, following: false, followedBy: true })).toBe(
        'other',
      );
    });
  });

  describe('canSee', () => {
    const table: [Relation, PrivacyLevel, boolean][] = [
      ['self', 'public', true],
      ['self', 'friends', true],
      ['self', 'private', true],
      ['friend', 'public', true],
      ['friend', 'friends', true],
      ['friend', 'private', false],
      ['other', 'public', true],
      ['other', 'friends', false],
      ['other', 'private', false],
      ['blocked', 'public', false],
      ['blocked', 'friends', false],
      ['blocked', 'private', false],
    ];
    it.each(table)('%s viewer, %s content → %s', (relation, level, expected) => {
      expect(canSee(level, relation)).toBe(expected);
    });

    it('never lets a blocked viewer see anything', () => {
      for (const level of LEVELS) expect(canSee(level, 'blocked')).toBe(false);
    });
  });

  it('has the five spec §19.1 categories', () => {
    expect(PRIVACY_CATEGORIES).toEqual([
      'profile',
      'forest',
      'statistics',
      'badges',
      'currentTree',
    ]);
  });

  it('defaults to friends only, with statistics private (docs/02 Privacy)', () => {
    expect(PRIVACY_DEFAULTS).toEqual({
      profile: 'friends',
      forest: 'friends',
      statistics: 'private',
      badges: 'friends',
      currentTree: 'friends',
    });
  });

  it('keeps the defaults frozen', () => {
    expect(Object.isFrozen(PRIVACY_DEFAULTS)).toBe(true);
  });
});
