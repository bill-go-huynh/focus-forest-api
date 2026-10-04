import {
  decodeForestCursor,
  encodeForestCursor,
  forestPage,
  forestProgression,
  type ForestProgressionRules,
} from './forest-timeline.js';

const month = (year: number, value: number) => ({ year, month: value });

describe('forest timeline pages', () => {
  it('walks every month from the newest to the first, without a gap', () => {
    const start = month(2025, 11);
    const end = month(2026, 2);
    expect(forestPage(start, end, { limit: 3 })).toEqual({
      months: [month(2026, 2), month(2026, 1), month(2025, 12)],
      next: month(2025, 12),
    });
    expect(forestPage(start, end, { limit: 3, after: month(2025, 12) })).toEqual({
      months: [month(2025, 11)],
      next: null,
    });
  });

  it('ends without a next page when the last page is exactly full', () => {
    expect(forestPage(month(2026, 1), month(2026, 2), { limit: 2 })).toEqual({
      months: [month(2026, 2), month(2026, 1)],
      next: null,
    });
  });

  it('has the current month only for a user who joined this month', () => {
    expect(forestPage(month(2026, 10), month(2026, 10), { limit: 24 })).toEqual({
      months: [month(2026, 10)],
      next: null,
    });
  });

  it('has nothing after the first month', () => {
    expect(forestPage(month(2026, 1), month(2026, 2), { limit: 5, after: month(2026, 1) })).toEqual(
      { months: [], next: null },
    );
  });
});

describe('forest cursor', () => {
  it('round-trips a month and refuses anything else', () => {
    const cursor = encodeForestCursor(month(2026, 9));
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeForestCursor(cursor)).toEqual(month(2026, 9));
    for (const bad of [
      '',
      'not a cursor',
      Buffer.from('{"v":1,"y":2026,"m":13}').toString('base64url'),
      Buffer.from('{"v":2,"y":2026,"m":1}').toString('base64url'),
      Buffer.from('{"v":1,"y":2026,"m":1,"x":1}').toString('base64url'),
      Buffer.from('[]').toString('base64url'),
    ]) {
      expect(decodeForestCursor(bad)).toBeNull();
    }
  });
});

describe('forest progression', () => {
  const rules: ForestProgressionRules = {
    levelThresholds: [1, 3, 6],
    areaLevels: { lake: 2, mountains: 3, night: 4, seasonal: 4, decorations: 3 },
  };

  it('starts at level 1 with no area', () => {
    expect(forestProgression(0, rules)).toEqual({
      level: 1,
      maxLevel: 4,
      treeCount: 0,
      nextLevelAt: 1,
      unlockedAreas: [],
    });
  });

  it('rises with planted trees and unlocks the areas of each level, in a stable order', () => {
    expect(forestProgression(3, rules)).toEqual({
      level: 3,
      maxLevel: 4,
      treeCount: 3,
      nextLevelAt: 6,
      unlockedAreas: ['lake', 'mountains', 'decorations'],
    });
    expect(forestProgression(40, rules)).toMatchObject({
      level: 4,
      nextLevelAt: null,
      unlockedAreas: ['lake', 'mountains', 'night', 'seasonal', 'decorations'],
    });
  });

  it('never takes back an area already unlocked, even below its level now', () => {
    expect(forestProgression(1, rules, ['night', 'lake'])).toEqual({
      level: 2,
      maxLevel: 4,
      treeCount: 1,
      nextLevelAt: 3,
      unlockedAreas: ['lake', 'night'],
    });
  });

  it('keeps an unlocked area this version no longer knows, after the known ones', () => {
    expect(forestProgression(0, rules, ['waterfall', 'lake']).unlockedAreas).toEqual([
      'lake',
      'waterfall',
    ]);
  });
});
