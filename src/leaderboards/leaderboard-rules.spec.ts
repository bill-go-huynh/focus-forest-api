import {
  fairScore,
  monthPeriod,
  rankRows,
  weekPeriod,
  weightsProblem,
  type ScoreWeights,
} from './leaderboard-rules.js';

const WEIGHTS: ScoreWeights = { consistency: 30, goals: 30, activeDays: 20, focusTime: 20 };

describe('fairScore', () => {
  it('blends kept days, goal days, active days, and capped focus time', () => {
    // 5 of 7 days each way, 150 of 840 capped minutes.
    expect(
      fairScore(
        { periodDays: 7, keptDays: 5, goalMetDays: 5, dailyMinutes: [30, 30, 30, 30, 30] },
        WEIGHTS,
        120,
      ),
    ).toBe(607);
  });

  it('caps each day, so one long day never dominates', () => {
    expect(
      fairScore({ periodDays: 7, keptDays: 1, goalMetDays: 1, dailyMinutes: [600] }, WEIGHTS, 120),
    ).toBe(143);
    expect(
      fairScore(
        { periodDays: 7, keptDays: 1, goalMetDays: 1, dailyMinutes: [600] },
        { consistency: 0, goals: 0, activeDays: 0, focusTime: 1 },
        600,
      ),
    ).toBe(143);
  });

  it('counts rest days as kept, never as active', () => {
    expect(
      fairScore(
        { periodDays: 7, keptDays: 5, goalMetDays: 3, dailyMinutes: [30, 30, 30] },
        WEIGHTS,
        120,
      ),
    ).toBe(450);
  });

  it('is 1000 for a full period and 0 for an empty one', () => {
    expect(
      fairScore(
        { periodDays: 2, keptDays: 2, goalMetDays: 2, dailyMinutes: [120, 200] },
        WEIGHTS,
        120,
      ),
    ).toBe(1000);
    expect(
      fairScore({ periodDays: 7, keptDays: 0, goalMetDays: 0, dailyMinutes: [] }, WEIGHTS, 120),
    ).toBe(0);
  });

  it('weighs each part on its own', () => {
    const only = (part: keyof ScoreWeights): ScoreWeights => ({
      consistency: 0,
      goals: 0,
      activeDays: 0,
      focusTime: 0,
      [part]: 10,
    });
    const input = { periodDays: 10, keptDays: 8, goalMetDays: 4, dailyMinutes: [60, 60] };
    expect(fairScore(input, only('consistency'), 120)).toBe(800);
    expect(fairScore(input, only('goals'), 120)).toBe(400);
    expect(fairScore(input, only('activeDays'), 120)).toBe(200);
    expect(fairScore(input, only('focusTime'), 120)).toBe(100);
  });
});

describe('weightsProblem', () => {
  it('refuses focus time alone, or nothing at all', () => {
    expect(weightsProblem(WEIGHTS)).toBeNull();
    expect(
      weightsProblem({ consistency: 0, goals: 0, activeDays: 0, focusTime: 100 }),
    ).not.toBeNull();
    expect(
      weightsProblem({ consistency: 0, goals: 0, activeDays: 0, focusTime: 0 }),
    ).not.toBeNull();
    expect(weightsProblem({ consistency: 0, goals: 1, activeDays: 0, focusTime: 0 })).toBeNull();
  });
});

describe('rankRows', () => {
  it('ranks by score, ties sharing a rank, listed by name then id', () => {
    const ranked = rankRows([
      { id: 'c', name: 'Cyd', score: 10 },
      { id: 'b', name: 'Bob', score: 30 },
      { id: 'a2', name: 'Ada', score: 10 },
      { id: 'a1', name: 'Ada', score: 10 },
      { id: 'd', name: 'Dan', score: 5 },
    ]);
    expect(ranked.map((row) => [row.id, row.rank])).toEqual([
      ['b', 1],
      ['a1', 2],
      ['a2', 2],
      ['c', 2],
      ['d', 5],
    ]);
  });
});

describe('periods', () => {
  it('runs a week from Monday and a month from the first', () => {
    expect(weekPeriod('2026-10-18')).toEqual({ startDate: '2026-10-12', endDate: '2026-10-18' });
    expect(weekPeriod('2026-10-19')).toEqual({ startDate: '2026-10-19', endDate: '2026-10-25' });
    expect(monthPeriod('2026-02-10')).toEqual({ startDate: '2026-02-01', endDate: '2026-02-28' });
  });
});
