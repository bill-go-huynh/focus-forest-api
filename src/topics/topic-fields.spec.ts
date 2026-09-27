import {
  canonicalText,
  codePointLength,
  createFingerprint,
  isTopicColor,
  isTopicIcon,
  TOPIC_COLORS,
} from './topic-fields.js';

describe('topic fields', () => {
  describe('canonicalText', () => {
    it('trims surrounding whitespace', () => {
      expect(canonicalText('  Reading \n')).toBe('Reading');
    });

    it('stores one Unicode form, so equal-looking names compare equal', () => {
      const decomposed = 'Đọc sách'; // "Đọc sách" with combining marks
      expect(canonicalText(decomposed)).toBe('Đọc sách');
      expect(canonicalText(decomposed)).toBe(canonicalText('Đọc sách'));
    });

    it('leaves non-strings alone for the validators to reject', () => {
      expect(canonicalText(42)).toBe(42);
      expect(canonicalText(null)).toBeNull();
    });
  });

  it('counts Unicode characters, not UTF-16 units', () => {
    expect(codePointLength('abc')).toBe(3);
    expect(codePointLength('🌱🌳')).toBe(2);
    expect(codePointLength('Đọc')).toBe(3);
  });

  describe('colors', () => {
    it('are exactly topic.1 to topic.12', () => {
      expect(TOPIC_COLORS).toHaveLength(12);
      expect(TOPIC_COLORS[0]).toBe('topic.1');
      expect(TOPIC_COLORS[11]).toBe('topic.12');
    });

    it.each(['topic.1', 'topic.7', 'topic.12'])('accepts %s', (color) => {
      expect(isTopicColor(color)).toBe(true);
    });

    it.each(['topic.0', 'topic.13', 'topic.01', 'topic.1 ', '#3B7349', 'moss', '', 7, null])(
      'rejects %j',
      (color) => {
        expect(isTopicColor(color)).toBe(false);
      },
    );
  });

  describe('icons', () => {
    it.each(['book', 'music-note', 'icon.book', 'code2', 'a'])('accepts %s', (icon) => {
      expect(isTopicIcon(icon)).toBe(true);
    });

    it.each([
      '',
      'Book',
      'book icon',
      '../book',
      '-book',
      'book-',
      'book..open',
      '2book',
      '📚',
      'a'.repeat(65),
      42,
      null,
    ])('rejects %j', (icon) => {
      expect(isTopicIcon(icon)).toBe(false);
    });
  });

  describe('createFingerprint', () => {
    const base = { name: 'Reading', icon: 'book', color: 'topic.1', description: null };

    it('is the same for the same canonical payload', () => {
      expect(createFingerprint(base)).toBe(createFingerprint({ ...base }));
    });

    it.each([
      ['name', { name: 'Writing' }],
      ['name case', { name: 'reading' }],
      ['icon', { icon: 'pen' }],
      ['color', { color: 'topic.2' }],
      ['description', { description: 'Novels' }],
    ])('changes with the %s', (_field, change) => {
      expect(createFingerprint({ ...base, ...change })).not.toBe(createFingerprint(base));
    });

    it('cannot be confused by field boundaries', () => {
      expect(createFingerprint({ ...base, name: 'a', description: 'bc' })).not.toBe(
        createFingerprint({ ...base, name: 'ab', description: 'c' }),
      );
    });
  });
});
