import type { TreeProgressDto } from './tree.contracts.js';
import {
  archivedTreeState,
  parseRecapContent,
  parseTreeArchive,
  type RecapContent,
  type TreeArchive,
} from './tree-archive.js';

const progress: TreeProgressDto = {
  stage: 'growing_tree',
  stageNumber: 4,
  progressToNextStage: 0.25,
  growthMinutes: 810,
  fullness: { level: 2, maxLevel: 5 },
  blossoms: { level: 1, maxLevel: 7 },
  richness: { tier: 0, maxTier: 5 },
};

const stats = {
  focusedMinutes: 810,
  sessionCount: 9,
  activeDays: 7,
  dailyGoalsMet: 2,
  weeklyGoalsMet: 0,
  longestStreak: 5,
  topTopic: {
    id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    name: 'Maths',
    icon: 'book',
    color: 'topic.1',
  },
};

const archive: TreeArchive = {
  timezone: 'Asia/Ho_Chi_Minh',
  progress,
  traits: [{ id: 'streak-days:3', earnedAt: '2026-10-03T10:00:00.000Z' }],
  stats,
};

const recap: RecapContent = {
  stats,
  mostProductiveDay: { date: '2026-10-05', focusedMinutes: 240 },
  mostProductiveWeek: { weekStart: '2026-10-05', focusedMinutes: 400 },
  newRecords: [
    { kind: 'most_focused_month', value: 810, unit: 'minutes', achievedOn: '2026-10-01' },
  ],
  highlightedNotes: [
    { sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', note: 'Finished the proof' },
  ],
  badges: [],
  events: [],
};

describe('archived tree snapshot', () => {
  it('accepts a complete snapshot, unchanged', () => {
    expect(parseTreeArchive(archive)).toEqual(archive);
    expect(parseTreeArchive({ ...archive, stats: { ...stats, topTopic: null } })).toMatchObject({
      stats: { topTopic: null },
    });
  });

  it.each([
    ['not an object', null],
    ['no time zone', { ...archive, timezone: undefined }],
    ['bad progress', { ...archive, progress: { ...progress, stage: 'oak' } }],
    ['bad traits', { ...archive, traits: [{ id: 3 }] }],
    ['missing stats', { ...archive, stats: { ...stats, longestStreak: undefined } }],
    ['a vitality', { ...archive, vitality: 'thriving' }],
  ])('refuses %s', (_, value) => {
    expect(() => parseTreeArchive(value)).toThrow(/tree archive/i);
  });

  it('shows as an archived tree at rest, from the snapshot alone', () => {
    const state = archivedTreeState(
      {
        year: 2026,
        month: 10,
        species: 'signature',
        variationSeed: 3_078_237_722n,
        configVersion: 4,
        prorationNumerator: 16,
        prorationDenominator: 31,
      },
      archive,
    );
    expect(state).toEqual({
      year: 2026,
      month: 10,
      status: 'archived',
      species: 'signature',
      variationSeed: 3_078_237_722,
      partialFirstMonth: true,
      configVersion: 4,
      progress,
      traits: archive.traits,
      vitality: null,
    });
  });
});

const T = '2026-10-03T10:00:00.000Z';

describe('recap snapshot', () => {
  it('accepts a complete recap, unchanged', () => {
    expect(parseRecapContent(recap)).toEqual(recap);
    expect(
      parseRecapContent({ ...recap, mostProductiveDay: null, mostProductiveWeek: null }),
    ).toMatchObject({ mostProductiveDay: null });
  });

  it('keeps the badges earned in the month by stable id and time, as stored (A4.2)', () => {
    const badges = [
      { badgeId: 'first-session', earnedAt: '2026-10-01T08:00:00.000Z' },
      { badgeId: 'focus-streak:3', earnedAt: T },
    ];
    expect(parseRecapContent({ ...recap, badges })).toEqual({ ...recap, badges });
  });

  it.each([
    ['not an object', 'recap'],
    ['bad records', { ...recap, newRecords: [{ kind: 'fastest', value: 1 }] }],
    ['badges that are not a list', { ...recap, badges: null }],
    ['an empty note', { ...recap, highlightedNotes: [{ sessionId: 'x', note: '' }] }],
    ['a note without its session', { ...recap, highlightedNotes: [{ note: 'text' }] }],
    [
      'more than session and note',
      { ...recap, highlightedNotes: [{ sessionId: 'x', note: 'a', topicId: 'y' }] },
    ],
    ['the old id list', { ...recap, highlightedSessionIds: [] }],
    ['a badge without its time', { ...recap, badges: [{ badgeId: 'first-session' }] }],
    ['a badge by display name', { ...recap, badges: [{ badgeId: 'First Session', earnedAt: T }] }],
    ['a badge with more fields', { ...recap, badges: [{ badgeId: 'a', earnedAt: T, name: 'A' }] }],
  ])('refuses %s', (_, value) => {
    expect(() => parseRecapContent(value)).toThrow(/recap/i);
  });
});
