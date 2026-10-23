import { DemoTooEarlyError, worldPlan, type PlannedSession } from './demo-plan.js';

/**
 * DM.1 The demo world's histories (spec/demo/PLAN.md): each account poised so one real session
 * on the phone triggers the moment to show. Dates are the presenter's local dates.
 */

const TODAY = '2026-10-20';
const sum = (sessions: readonly PlannedSession[], prefix: string) =>
  sessions.filter((s) => s.localDate.startsWith(prefix)).reduce((t, s) => t + s.minutes, 0);
const dates = (sessions: readonly PlannedSession[]) =>
  [...new Set(sessions.map((s) => s.localDate))].sort();
/** The longest run of consecutive dates. */
function longestRun(sessions: readonly PlannedSession[]): number {
  const days = dates(sessions).map((d) => Date.parse(`${d}T00:00:00Z`) / 86_400_000);
  let best = 0;
  let run = 0;
  days.forEach((d, i) => {
    run = i > 0 && d - days[i - 1]! === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
}

describe('worldPlan', () => {
  const plan = worldPlan(TODAY);

  it('gives the main presenter an August tree, a full September one, and nothing this month', () => {
    const s = plan.main;
    expect(sum(s, '2026-08')).toBe(600);
    expect(sum(s, '2026-09')).toBe(2395);
    // This month's tree is still a Seed, so its species can be chosen (owner, 2026-10-23).
    expect(sum(s, '2026-10')).toBe(0);
    // 2,995 in all: one 5-minute session passes 50 hours (3,000 minutes).
    expect(sum(s, '2026')).toBe(2995);
  });

  it('gives September one 7-day run (the 7-Day Streak and Pine), and no longer one', () => {
    const s = plan.main;
    expect(
      dates(s)
        .filter((d) => d.startsWith('2026-09'))
        .slice(0, 7),
    ).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
      '2026-09-07',
    ]);
    expect(longestRun(s)).toBe(7);
  });

  it('keeps every day under the daily soft cap and every session counted', () => {
    for (const persona of [plan.main, plan.comeback, plan.recovery, ...plan.friends]) {
      const perDay = new Map<string, number>();
      for (const s of persona) perDay.set(s.localDate, (perDay.get(s.localDate) ?? 0) + s.minutes);
      expect(Math.max(...perDay.values())).toBeLessThanOrEqual(240);
      expect(Math.min(...persona.map((s) => s.minutes))).toBeGreaterThanOrEqual(5);
    }
  });

  it('starts some sessions before 7 in the morning, for Early Bird progress', () => {
    expect(plan.main.filter((s) => s.startHour < 7).length).toBe(6);
  });

  it('leaves the comeback presenter four days without focus (a quiet tree)', () => {
    expect(dates(plan.comeback).at(-1)).toBe('2026-10-16');
  });

  it('gives the recovery presenter a 4-day streak that missed only yesterday', () => {
    expect(dates(plan.recovery).slice(-4)).toEqual([
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ]);
    expect(dates(plan.recovery)).not.toContain('2026-10-14');
    expect(dates(plan.recovery)).not.toContain('2026-10-19');
  });

  it('gives three friends sessions yesterday that add up to 290 minutes', () => {
    expect(plan.friends).toHaveLength(3);
    expect(plan.friends.map((f) => sum(f, '2026-10-19')).reduce((a, b) => a + b, 0)).toBe(290);
  });

  it('never plans a session today or later', () => {
    for (const persona of [plan.main, plan.comeback, plan.recovery, ...plan.friends]) {
      expect(persona.every((s) => s.localDate < TODAY)).toBe(true);
    }
  });

  it('needs the 8th of the month or later', () => {
    expect(() => worldPlan('2026-10-07')).toThrow(DemoTooEarlyError);
    expect(() => worldPlan('2026-10-08')).not.toThrow();
  });

  it('works across a year boundary', () => {
    const january = worldPlan('2027-01-20');
    expect(sum(january.main, '2026-11')).toBe(600);
    expect(sum(january.main, '2026-12')).toBe(2395);
    expect(sum(january.main, '2027-01')).toBe(0);
  });
});
