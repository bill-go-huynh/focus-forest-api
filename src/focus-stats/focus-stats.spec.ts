import { isCounted, summarizeDays, summarizeFocus, type StatsSession } from './focus-stats.js';

const MIN = 60_000;
const session = (
  localDate: string,
  minutes: number,
  overrides: Partial<StatsSession> = {},
): StatsSession => ({
  localDate,
  focusedMilliseconds: minutes * MIN,
  status: 'completed',
  topicId: 'topic-a',
  ...overrides,
});

describe('which sessions count', () => {
  it('counts completed and ended-early sessions, never discarded ones', () => {
    expect(isCounted('completed')).toBe(true);
    expect(isCounted('ended_early')).toBe(true);
    expect(isCounted('discarded')).toBe(false);
  });
});

describe('summarizeFocus', () => {
  const sessions: StatsSession[] = [
    session('2026-09-28', 30), // Monday
    session('2026-09-28', 45, { status: 'ended_early', topicId: 'topic-b' }),
    session('2026-09-28', 3, { status: 'discarded' }),
    session('2026-10-04', 50), // Sunday, same week
    session('2026-10-05', 25, { topicId: 'topic-b' }), // next Monday
    session('2026-10-06', 4, { status: 'discarded', topicId: 'topic-c' }),
  ];

  it('totals counted sessions only', () => {
    const summary = summarizeFocus(sessions);
    expect(summary.focusedMilliseconds).toBe((30 + 45 + 50 + 25) * MIN);
    expect(summary.sessionCount).toBe(4);
    expect(summary.longestSessionMilliseconds).toBe(50 * MIN);
  });

  it('groups by the stored local date', () => {
    expect(summarizeFocus(sessions).days).toEqual([
      { date: '2026-09-28', focusedMilliseconds: 75 * MIN, sessionCount: 2 },
      { date: '2026-10-04', focusedMilliseconds: 50 * MIN, sessionCount: 1 },
      { date: '2026-10-05', focusedMilliseconds: 25 * MIN, sessionCount: 1 },
    ]);
  });

  it('lists active dates: days with at least one counted session', () => {
    expect(summarizeFocus(sessions).activeDates).toEqual([
      '2026-09-28',
      '2026-10-04',
      '2026-10-05',
    ]);
  });

  it('groups weeks from Monday to Sunday', () => {
    expect(summarizeFocus(sessions).weeks).toEqual([
      {
        weekStart: '2026-09-28',
        focusedMilliseconds: 125 * MIN,
        sessionCount: 3,
        activeDays: 2,
      },
      { weekStart: '2026-10-05', focusedMilliseconds: 25 * MIN, sessionCount: 1, activeDays: 1 },
    ]);
  });

  it('totals topics, largest first, without discarded sessions', () => {
    expect(summarizeFocus(sessions).topics).toEqual([
      { topicId: 'topic-a', focusedMilliseconds: 80 * MIN, sessionCount: 2 },
      { topicId: 'topic-b', focusedMilliseconds: 70 * MIN, sessionCount: 2 },
    ]);
  });

  it('does not depend on the order of the sessions', () => {
    expect(summarizeFocus([...sessions].reverse())).toEqual(summarizeFocus(sessions));
  });

  it('is empty without counted sessions', () => {
    expect(summarizeFocus([session('2026-09-28', 2, { status: 'discarded' })])).toEqual({
      focusedMilliseconds: 0,
      sessionCount: 0,
      longestSessionMilliseconds: 0,
      days: [],
      activeDates: [],
      weeks: [],
      topics: [],
    });
  });
});

describe('summarizeDays (per-day totals from the database)', () => {
  it('derives weeks and active dates from daily totals, in any order', () => {
    const days = [
      { date: '2026-10-05', focusedMilliseconds: 25 * MIN, sessionCount: 1 },
      { date: '2026-09-28', focusedMilliseconds: 75 * MIN, sessionCount: 2 },
      { date: '2026-10-04', focusedMilliseconds: 0, sessionCount: 0 },
    ];
    expect(summarizeDays(days)).toEqual({
      focusedMilliseconds: 100 * MIN,
      sessionCount: 3,
      days: [
        { date: '2026-09-28', focusedMilliseconds: 75 * MIN, sessionCount: 2 },
        { date: '2026-10-05', focusedMilliseconds: 25 * MIN, sessionCount: 1 },
      ],
      activeDates: ['2026-09-28', '2026-10-05'],
      weeks: [
        { weekStart: '2026-09-28', focusedMilliseconds: 75 * MIN, sessionCount: 2, activeDays: 1 },
        { weekStart: '2026-10-05', focusedMilliseconds: 25 * MIN, sessionCount: 1, activeDays: 1 },
      ],
    });
  });
});
