import type { DayFocus } from '../focus-stats/focus-stats.js';
import {
  averagePerActiveDay,
  dailyGoalRate,
  dayCells,
  topicShares,
  weeklyGoalRate,
} from './insights.js';

const MIN = 60_000;
const day = (date: string, minutes: number, sessionCount = 1): DayFocus => ({
  date,
  focusedMilliseconds: minutes * MIN,
  sessionCount,
});

describe('day cells', () => {
  const cells = (partial: Partial<Parameters<typeof dayCells>[0]> = {}) =>
    dayCells({
      from: '2026-10-05',
      to: '2026-10-11',
      today: '2026-10-08',
      days: [],
      restDates: [],
      dailyVersions: [],
      ...partial,
    });

  it('has one cell per date, empty days included, with no goal before the first one', () => {
    const result = cells({ days: [day('2026-10-06', 40, 2)] });
    expect(result.map((cell) => cell.date)).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ]);
    expect(result[1]).toEqual({
      date: '2026-10-06',
      focusedMilliseconds: 40 * MIN,
      sessionCount: 2,
      active: true,
      rest: false,
      dailyGoal: 'none',
      dailyGoalMinutes: null,
    });
    expect(result[0]).toMatchObject({ active: false, focusedMilliseconds: 0, dailyGoal: 'none' });
  });

  it('judges each day by the goal in effect then; today and later are pending until met', () => {
    const result = cells({
      days: [day('2026-10-06', 30), day('2026-10-07', 10), day('2026-10-08', 5)],
      dailyVersions: [
        { effectiveFrom: '2026-10-06', minutes: 30 },
        { effectiveFrom: '2026-10-07', minutes: 20 },
      ],
    });
    expect(result.map((cell) => [cell.date, cell.dailyGoal, cell.dailyGoalMinutes])).toEqual([
      ['2026-10-05', 'none', null],
      ['2026-10-06', 'met', 30],
      ['2026-10-07', 'not_met', 20],
      ['2026-10-08', 'pending', 20],
      ['2026-10-09', 'pending', 20],
      ['2026-10-10', 'pending', 20],
      ['2026-10-11', 'pending', 20],
    ]);
  });

  it('keeps a rest day with focus both a rest day and a day with focus', () => {
    const [cell] = cells({
      from: '2026-10-06',
      to: '2026-10-06',
      days: [day('2026-10-06', 50)],
      restDates: ['2026-10-06'],
      dailyVersions: [{ effectiveFrom: '2026-10-01', minutes: 30 }],
    });
    expect(cell).toMatchObject({ rest: true, active: true, dailyGoal: 'met' });
  });
});

describe('daily goal rate', () => {
  it('counts days with a goal that are decided, leaving out rest days without the goal met', () => {
    const result = dayCells({
      from: '2026-10-01',
      to: '2026-10-08',
      today: '2026-10-07',
      days: [day('2026-10-03', 40), day('2026-10-04', 40), day('2026-10-05', 5)],
      restDates: ['2026-10-04', '2026-10-06'],
      dailyVersions: [{ effectiveFrom: '2026-10-03', minutes: 30 }],
    });
    // 1–2 October: no goal yet. 3: met. 4: rest, met. 5: missed. 6: rest, not met (left out).
    // 7 (today) and 8: still pending.
    expect(dailyGoalRate(result)).toEqual({ completed: 2, eligible: 3 });
  });
});

describe('weekly goal rate of a month', () => {
  const october = { year: 2026, month: 10 };
  const goal = { type: 'focused_minutes' as const, target: 60 };

  it('owns each week by the month of its Monday, the week’s days in any month counting', () => {
    const result = weeklyGoalRate({
      month: october,
      today: '2026-11-20',
      // Monday 28 September belongs to September, Monday 26 October to October.
      days: [day('2026-09-30', 60), day('2026-10-06', 60), day('2026-11-01', 60)],
      weeklyVersions: [{ effectiveFrom: '2026-09-28', goal }],
    });
    // October's weeks: 5, 12, 19, 26 October. Met: 5 (6 Oct), 26 (1 Nov).
    expect(result).toEqual({ completed: 2, eligible: 4 });
  });

  it('leaves out weeks without a goal and a week still in progress unless already met', () => {
    const result = weeklyGoalRate({
      month: october,
      today: '2026-10-21',
      days: [day('2026-10-13', 60), day('2026-10-20', 10)],
      weeklyVersions: [
        { effectiveFrom: '2026-10-12', goal },
        { effectiveFrom: '2026-10-26', goal: null },
      ],
    });
    // 5 Oct: no goal. 12 Oct: met. 19 Oct: in progress, not met. 26 Oct: goal cleared.
    expect(result).toEqual({ completed: 1, eligible: 1 });
  });
});

describe('topic shares and averages', () => {
  it('gives each topic its share of the total, rounded to four decimals', () => {
    const shares = topicShares([
      { topicId: 'a', focusedMilliseconds: 2 * MIN },
      { topicId: 'b', focusedMilliseconds: 1 * MIN },
    ]);
    expect(shares.map((topic) => topic.share)).toEqual([0.6667, 0.3333]);
    expect(topicShares([])).toEqual([]);
  });

  it('averages over active days only', () => {
    expect(averagePerActiveDay(90 * MIN, 2)).toBe(45 * MIN);
    expect(averagePerActiveDay(0, 0)).toBeNull();
  });
});
