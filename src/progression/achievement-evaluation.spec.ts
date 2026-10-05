import type { ActivityHistory } from '../consistency/streak.js';
import {
  EVALUATED_CATEGORIES,
  achievementValues,
  earnableAchievements,
  isReached,
  parseProgressionResult,
  planGrants,
  progressOf,
  withoutRecovery,
  withoutSession,
  type AchievementInput,
  type EarnableAchievement,
} from './achievement-evaluation.js';

const now = new Date('2026-10-10T12:00:00.000Z');
const MIN = 60_000;

const history = (activeDates: string[], restDates: string[] = []): ActivityHistory => ({
  activeDates,
  restDates,
  recoveredDates: [],
});

const input = (
  sessionCount: number,
  minutes: number,
  activeDates: string[] = [],
  restDates: string[] = [],
): AchievementInput => ({
  lifetime: { sessionCount, focusedMilliseconds: minutes * MIN },
  history: history(activeDates, restDates),
});

type Definition = Parameters<typeof earnableAchievements>[0][number];

const definition = (
  id: string,
  criterion: EarnableAchievement['criterion'],
  target: number,
  badge: Partial<Definition['badge']> = {},
): Definition => ({
  id,
  badgeId: id,
  criterion,
  target,
  progressVisible: true,
  badge: {
    id,
    category: 'focus',
    rarity: 'common',
    source: 'achievement',
    availability: 'permanent',
    status: 'active',
    availableFrom: null,
    availableUntil: null,
    sortOrder: 0,
    ...badge,
  },
});

describe('achievement values: derived from Core truth, never counted separately', () => {
  it('counts counted sessions, whole focused minutes, and the longest streak in days', () => {
    expect(
      achievementValues(input(4, 59.99, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05'])),
    ).toEqual({ counted_sessions: 4, focused_minutes: 59, longest_streak_days: 3 });
  });

  it('uses the longest streak, not the current one: a broken streak keeps its record', () => {
    const values = achievementValues(input(3, 90, ['2026-09-01', '2026-09-02', '2026-09-03']));
    expect(values.longest_streak_days).toBe(3);
  });

  it('counts rest days as bridges that add no streak day', () => {
    const values = achievementValues(
      input(3, 90, ['2026-09-01', '2026-09-03', '2026-09-04'], ['2026-09-02']),
    );
    expect(values.longest_streak_days).toBe(3);
  });

  it('removes one counted session: its focus, its count, and its day when it was alone', () => {
    const all = input(3, 100, ['2026-10-01', '2026-10-02', '2026-10-03']);
    const alone = withoutSession(all, {
      focusedMilliseconds: 40 * MIN,
      localDate: '2026-10-03',
      countedOnSameDay: 1,
    });
    expect(achievementValues(alone)).toEqual({
      counted_sessions: 2,
      focused_minutes: 60,
      longest_streak_days: 2,
    });
    const shared = withoutSession(all, {
      focusedMilliseconds: 40 * MIN,
      localDate: '2026-10-03',
      countedOnSameDay: 2,
    });
    expect(achievementValues(shared).longest_streak_days).toBe(3);
  });
});

describe('withoutRecovery: the values just before a streak recovery (A4.2.G)', () => {
  it('removes only the recovered day: no focus, no session, no active day changes', () => {
    const all: AchievementInput = {
      lifetime: { sessionCount: 4, focusedMilliseconds: 80 * MIN },
      history: {
        activeDates: ['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05'],
        restDates: [],
        recoveredDates: ['2026-10-03'],
      },
    };
    expect(achievementValues(all)).toEqual({
      counted_sessions: 4,
      focused_minutes: 80,
      longest_streak_days: 4,
    });
    expect(achievementValues(withoutRecovery(all, '2026-10-03'))).toEqual({
      counted_sessions: 4,
      focused_minutes: 80,
      longest_streak_days: 2,
    });
  });
});

describe('thresholds', () => {
  it('are reached at exactly the target, and above it, never below', () => {
    expect(isReached(599, 600)).toBe(false);
    expect(isReached(600, 600)).toBe(true);
    expect(isReached(601, 600)).toBe(true);
  });
});

describe('earnable achievements', () => {
  it('are active, acquirable, and in a category whose criteria exist (focus, consistency)', () => {
    expect(EVALUATED_CATEGORIES).toEqual(['focus', 'consistency']);
    const earnable = earnableAchievements(
      [
        definition('a', 'counted_sessions', 1),
        definition('planned', 'counted_sessions', 1, { status: 'planned' }),
        definition('retired', 'counted_sessions', 1, { status: 'retired' }),
        definition('social', 'counted_sessions', 1, { category: 'social' }),
        definition('event', 'counted_sessions', 1, { category: 'event', source: 'event' }),
        definition('time', 'counted_sessions', 1, { category: 'time_based' }),
        definition('special', 'counted_sessions', 1, { category: 'rare' }),
        definition('scarce', 'counted_sessions', 1, { rarity: 'rare' }),
        definition('legend', 'counted_sessions', 1, {
          category: 'consistency',
          rarity: 'legendary',
        }),
      ],
      now,
    );
    // In catalog order: sort order, then id.
    expect(earnable.map((a) => a.id)).toEqual(['a', 'legend', 'scarce']);
  });

  it('respect a limited window', () => {
    const limited = definition('limited', 'counted_sessions', 1, {
      availability: 'limited',
      availableFrom: new Date('2026-11-01T00:00:00.000Z'),
      availableUntil: new Date('2026-12-01T00:00:00.000Z'),
    });
    expect(earnableAchievements([limited], now)).toEqual([]);
  });
});

describe('progress', () => {
  const tenHours = definition('focus-hours:10', 'focused_minutes', 600);

  it('shows the value toward the target before it is earned', () => {
    expect(progressOf(tenHours, 120, null)).toEqual({
      unit: 'minutes',
      current: 120,
      target: 600,
      completed: false,
      earnedAt: null,
    });
  });

  it('keeps counting above the target once earned, with the earned time kept', () => {
    const earnedAt = new Date('2026-09-01T10:00:00.000Z');
    expect(progressOf(tenHours, 900, earnedAt)).toEqual({
      unit: 'minutes',
      current: 900,
      target: 600,
      completed: true,
      earnedAt: earnedAt.toISOString(),
    });
  });

  it('is completed by ownership alone, whatever the value is now', () => {
    const earnedAt = new Date('2026-09-01T10:00:00.000Z');
    expect(progressOf(tenHours, 0, earnedAt).completed).toBe(true);
    expect(progressOf(tenHours, 600, null).completed).toBe(false);
  });
});

describe('planGrants: what this evaluation grants, and what the session caused', () => {
  const pending = [
    definition('first-session', 'counted_sessions', 1),
    definition('focus-hours:10', 'focused_minutes', 600),
    definition('focus-streak:3', 'longest_streak_days', 3),
  ];
  const crossings = new Map([['focus-hours:10', new Date('2026-08-20T09:00:00.000Z')]]);

  it('grants nothing below every target', () => {
    expect(
      planGrants(
        pending,
        {
          after: { counted_sessions: 0, focused_minutes: 0, longest_streak_days: 0 },
          before: null,
        },
        now,
        new Map(),
      ),
    ).toEqual([]);
  });

  it('marks what the session crossed as caused by it, earned now', () => {
    const grants = planGrants(
      pending,
      {
        after: { counted_sessions: 1, focused_minutes: 30, longest_streak_days: 1 },
        before: { counted_sessions: 0, focused_minutes: 0, longest_streak_days: 0 },
      },
      now,
      new Map(),
    );
    expect(grants).toEqual([{ badgeId: 'first-session', earnedAt: now, causedByAction: true }]);
  });

  it('dates what was already reached before (backlog) at its crossing, or now without one', () => {
    const grants = planGrants(
      pending,
      {
        after: { counted_sessions: 40, focused_minutes: 700, longest_streak_days: 4 },
        before: { counted_sessions: 39, focused_minutes: 680, longest_streak_days: 4 },
      },
      now,
      crossings,
    );
    expect(grants).toEqual([
      { badgeId: 'first-session', earnedAt: now, causedByAction: false },
      {
        badgeId: 'focus-hours:10',
        earnedAt: new Date('2026-08-20T09:00:00.000Z'),
        causedByAction: false,
      },
      { badgeId: 'focus-streak:3', earnedAt: now, causedByAction: false },
    ]);
  });

  it('never dates a grant later than now, nor before its badge opened', () => {
    const later = new Map([['focus-hours:10', new Date('2026-12-01T00:00:00.000Z')]]);
    const [grant] = planGrants(
      [definition('focus-hours:10', 'focused_minutes', 600)],
      {
        after: { counted_sessions: 0, focused_minutes: 600, longest_streak_days: 0 },
        before: null,
      },
      now,
      later,
    );
    expect(grant?.earnedAt).toEqual(now);

    const opened = new Date('2026-09-01T00:00:00.000Z');
    const [limited] = planGrants(
      [
        definition('focus-hours:10', 'focused_minutes', 600, {
          availability: 'limited',
          availableFrom: opened,
          availableUntil: new Date('2027-01-01T00:00:00.000Z'),
        }),
      ],
      {
        after: { counted_sessions: 0, focused_minutes: 600, longest_streak_days: 0 },
        before: null,
      },
      now,
      crossings,
    );
    expect(limited?.earnedAt).toEqual(opened);
  });
});

describe('the progression result stored with a session (replayed as stored)', () => {
  it('holds the badge ids the session caused, in order', () => {
    const result = { newlyEarnedBadgeIds: ['first-session', 'focus-streak:3'] };
    // A4.3 reads it with no unlocked rewards.
    const none = { newlyUnlockedSpeciesIds: [], newlyUnlockedCosmeticIds: [] };
    expect(parseProgressionResult(result)).toEqual({ ...result, ...none });
    expect(parseProgressionResult({ newlyEarnedBadgeIds: [] })).toEqual({
      newlyEarnedBadgeIds: [],
      ...none,
    });
  });

  it.each([
    ['not an object', null],
    ['no list', {}],
    ['a display name', { newlyEarnedBadgeIds: ['First Session'] }],
    ['a duplicate', { newlyEarnedBadgeIds: ['a', 'a'] }],
    ['more fields', { newlyEarnedBadgeIds: [], earnedAt: 'x' }],
  ])('refuses %s', (_, value) => {
    expect(() => parseProgressionResult(value)).toThrow(/progression result/i);
  });
});
