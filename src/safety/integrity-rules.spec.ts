import { integrityFlags, type IntegrityRules, type IntegritySession } from './integrity-rules.js';

/**
 * A7.3 Leaderboard integrity (Phase 7 owner decision 8: flags for staff, never automatic). Pure:
 * what in a person's stored sessions is implausible enough for a person to look at.
 */

const MIN = 60_000;
const RULES: IntegrityRules = {
  maxDailyFocusMinutes: 960,
  lateSubmissionHours: 72,
  spike: { ratio: 5, minMinutes: 600 },
};
let n = 0;
const session = (
  localDate: string,
  start: string,
  minutes: number,
  submittedAfterMinutes = 1,
): IntegritySession => {
  const startedAt = new Date(start);
  const endedAt = new Date(startedAt.getTime() + minutes * MIN);
  return {
    id: `s${++n}`,
    localDate,
    startedAt,
    endedAt,
    focusedMilliseconds: minutes * MIN,
    submittedAt: new Date(endedAt.getTime() + submittedAfterMinutes * MIN),
  };
};

describe('integrityFlags (A7.3)', () => {
  beforeEach(() => {
    n = 0;
  });

  it('flags nothing for an ordinary month', () => {
    const sessions = Array.from({ length: 20 }, (_, i) =>
      session(
        `2026-11-${String(i + 1).padStart(2, '0')}`,
        `2026-11-${String(i + 1).padStart(2, '0')}T08:00:00Z`,
        50,
      ),
    );
    expect(integrityFlags(sessions, RULES)).toEqual([]);
  });

  it('flags sessions that overlap, once per pair', () => {
    const a = session('2026-11-02', '2026-11-02T08:00:00Z', 60);
    const b = session('2026-11-02', '2026-11-02T08:30:00Z', 60);
    const c = session('2026-11-02', '2026-11-02T09:30:00Z', 30);
    expect(integrityFlags([c, b, a], RULES)).toEqual([
      {
        kind: 'overlap',
        key: 'overlap:s1:s2',
        detail: { sessionIds: ['s1', 's2'], overlapMinutes: 30 },
      },
    ]);
  });

  it('flags a local day with more focus than plausible', () => {
    const day = [
      session('2026-11-03', '2026-11-03T00:00:00Z', 500),
      session('2026-11-03', '2026-11-03T09:00:00Z', 500),
    ];
    expect(integrityFlags(day, RULES)).toEqual([
      {
        kind: 'day_total',
        key: 'day:2026-11-03',
        detail: { localDate: '2026-11-03', focusMinutes: 1000 },
      },
    ]);
    // Exactly at the limit is fine.
    expect(
      integrityFlags(
        [
          session('2026-11-04', '2026-11-04T00:00:00Z', 480),
          session('2026-11-04', '2026-11-04T09:00:00Z', 480),
        ],
        RULES,
      ),
    ).toEqual([]);
  });

  it('flags a session submitted long after it ended (beyond offline syncing)', () => {
    const late = session('2026-11-02', '2026-11-02T08:00:00Z', 30, 72 * 60 + 1);
    const fine = session('2026-11-03', '2026-11-03T08:00:00Z', 30, 72 * 60);
    expect(integrityFlags([late, fine], RULES)).toEqual([
      { kind: 'late', key: 'late:s1', detail: { sessionId: 's1', hoursLate: 72 } },
    ]);
  });

  it('flags a week far above the person’s usual weeks', () => {
    const usual = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'].map((monday) =>
      session(monday, `${monday}T08:00:00Z`, 120),
    );
    // The week of 2 November: 700 minutes, more than 5 × 120 and at least 600.
    const spike = [
      session('2026-11-02', '2026-11-02T08:00:00Z', 350),
      session('2026-11-04', '2026-11-04T08:00:00Z', 350),
    ];
    expect(integrityFlags([...usual, ...spike], RULES)).toEqual([
      {
        kind: 'spike',
        key: 'spike:2026-11-02',
        detail: { weekStart: '2026-11-02', focusMinutes: 700, usualMinutes: 120 },
      },
    ]);
  });

  it('never flags a first busy week: there is nothing usual to compare with', () => {
    const first = [
      session('2026-11-02', '2026-11-02T08:00:00Z', 350),
      session('2026-11-04', '2026-11-04T08:00:00Z', 350),
    ];
    expect(integrityFlags(first, RULES)).toEqual([]);
  });

  it('never flags a busy week below the floor, however quiet the weeks before', () => {
    const usual = [session('2026-10-26', '2026-10-26T08:00:00Z', 10)];
    const week = [session('2026-11-02', '2026-11-02T08:00:00Z', 590)];
    expect(integrityFlags([...usual, ...week], RULES)).toEqual([]);
  });
});
