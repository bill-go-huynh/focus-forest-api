import { day, HOUR, MIN, rulesWith, spread } from '../../test/support/tree-testing.js';
import type { DayFocus } from '../focus-stats/focus-stats.js';
import type { GrowthRules } from './growth-rules.js';
import { computeTreeGrowth, type MonthGrowthInput } from './tree-growth.js';

const rules = rulesWith();
const SEPTEMBER = { year: 2026, month: 9 }; // 30 days, starts on a Tuesday

function grow(
  days: readonly DayFocus[],
  overrides: Partial<MonthGrowthInput> = {},
  withRules: GrowthRules = rules,
) {
  return computeTreeGrowth(
    {
      month: SEPTEMBER,
      joinedOn: '2026-03-14',
      days,
      goalCompletions: { daily: 0, weekly: 0 },
      restDates: [],
      ...overrides,
    },
    withRules,
  );
}

describe('stage', () => {
  it('is Seed until a counted session exists', () => {
    expect(grow([]).stage).toBe('seed');
    expect(grow([{ date: '2026-09-02', focusedMilliseconds: 0, sessionCount: 0 }]).stage).toBe(
      'seed',
    );
  });

  it('is at least Sprout after the first counted session, however short', () => {
    expect(grow([day('2026-09-02', 5)]).stage).toBe('sprout');
  });

  it.each([
    [2 * HOUR - 1, 'sprout'],
    [2 * HOUR, 'young_tree'],
    [6 * HOUR - 1, 'young_tree'],
    [6 * HOUR, 'growing_tree'],
    [12 * HOUR - 1, 'growing_tree'],
    [12 * HOUR, 'mature_tree'],
    [20 * HOUR - 1, 'mature_tree'],
    [20 * HOUR, 'blooming_tree'],
    [30 * HOUR - 1, 'blooming_tree'],
    [30 * HOUR, 'final_form'],
    [90 * HOUR, 'final_form'],
  ])('%i ms of growth → %s', (growth, stage) => {
    expect(grow(spread(growth, '2026-09-01')).stage).toBe(stage);
  });

  it('follows changed thresholds without code changes', () => {
    const days = [day('2026-09-02', 90)];
    expect(grow(days).stage).toBe('sprout');
    expect(
      grow(days, {}, rulesWith({ 'growth.stageThresholds': [60, 120, 180, 240, 300] })).stage,
    ).toBe('young_tree');
  });
});

describe('daily soft cap', () => {
  it('slows growth from one marathon day but leaves the focus totals alone', () => {
    const marathon = grow([day('2026-09-02', 6 * 60, 3)]);
    expect(marathon.focusedMilliseconds).toBe(6 * HOUR);
    expect(marathon.sessionCount).toBe(3);
    expect(marathon.growthMilliseconds).toBe(4.8 * HOUR);
    expect(marathon.stage).toBe('young_tree');

    const twoDays = grow([day('2026-09-02', 3 * 60), day('2026-09-03', 3 * 60)]);
    expect(twoDays.growthMilliseconds).toBe(6 * HOUR);
    expect(twoDays.stage).toBe('growing_tree');
  });
});

describe('partial first month', () => {
  it('is not partial when the user joined before the month or on its first day', () => {
    expect(grow([]).firstMonth.partial).toBe(false);
    expect(grow([], { joinedOn: '2026-09-01' }).firstMonth.partial).toBe(false);
  });

  it('prorates the stage thresholds by the days remaining', () => {
    // Joined on the 16th: 15 / 30 → Young Tree at 1 h.
    const late = { joinedOn: '2026-09-16' };
    expect(grow([day('2026-09-16', 59)], late).stage).toBe('sprout');
    expect(grow([day('2026-09-16', 60)], late).stage).toBe('young_tree');
    expect(grow([day('2026-09-16', 60)], late).firstMonth).toEqual({
      partial: true,
      numerator: 15,
      denominator: 30,
    });
  });

  it('stops at the floor for a very late join', () => {
    // Joined on the 24th: 7 / 30 is below the 25 % floor → Young Tree at 30 min.
    const late = { joinedOn: '2026-09-24' };
    expect(grow([day('2026-09-24', 29)], late).stage).toBe('sprout');
    expect(grow([day('2026-09-24', 30)], late).stage).toBe('young_tree');
  });

  it('counts the days of a leap February', () => {
    // Joined on 15 February 2028: 15 / 29 → Young Tree at ceil(2 h × 15 / 29) = 3 724 138 ms.
    const february = { month: { year: 2028, month: 2 }, joinedOn: '2028-02-15' };
    expect(grow([day('2028-02-15', 62)], february).stage).toBe('sprout');
    expect(grow([day('2028-02-15', 63)], february).stage).toBe('young_tree');
  });

  it('never inflates focus, sessions, or active days', () => {
    const days = [day('2026-09-24', 40, 2), day('2026-09-25', 20)];
    const late = grow(days, { joinedOn: '2026-09-24' });
    const full = grow(days);
    expect(late.focusedMilliseconds).toBe(60 * MIN);
    expect(late.growthMilliseconds).toBe(60 * MIN);
    expect(late.sessionCount).toBe(3);
    expect(late.activeDays).toBe(2);
    expect([full.focusedMilliseconds, full.sessionCount, full.activeDays]).toEqual([
      late.focusedMilliseconds,
      late.sessionCount,
      late.activeDays,
    ]);
  });
});

describe('fullness', () => {
  const tenShortDays = Array.from({ length: 10 }, (_, i) =>
    day(`2026-09-${String(i + 1).padStart(2, '0')}`, 60),
  );

  it('grows with active days, not with hours', () => {
    const oneLongDay = grow([day('2026-09-02', 10 * 60)]);
    const tenDays = grow(tenShortDays);
    expect(tenDays.fullnessLevel).toBeGreaterThan(oneLongDay.fullnessLevel);

    const tenLongerDays = grow(tenShortDays.map((d) => ({ ...d, focusedMilliseconds: 3 * HOUR })));
    expect(tenLongerDays.fullnessLevel).toBe(tenDays.fullnessLevel);
  });

  it('rewards activity spread across the weeks over the same days in a burst', () => {
    // 12 active days: 3 in every week of September vs. 12 days in a row.
    const steady = [
      '2026-09-01', '2026-09-03', '2026-09-05',
      '2026-09-08', '2026-09-10', '2026-09-12',
      '2026-09-15', '2026-09-17', '2026-09-19',
      '2026-09-22', '2026-09-24', '2026-09-26',
    ].map((date) => day(date, 60)); // prettier-ignore
    const burst = spread(12 * HOUR, '2026-09-01', HOUR);
    expect(grow(steady).fullnessLevel).toBeGreaterThan(grow(burst).fullnessLevel);
  });

  it('reaches the top level with enough active days in every week', () => {
    const everyDay = spread(30 * HOUR, '2026-09-01', HOUR);
    expect(grow(everyDay).fullnessLevel).toBe(5);
  });

  it('does not hold planned rest days against weekly consistency', () => {
    // Two active days a week; the other days of each week planned as rest.
    const active: string[] = [];
    const rest: string[] = [];
    for (let d = 1; d <= 30; d += 1) {
      const date = `2026-09-${String(d).padStart(2, '0')}`;
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 1 = Monday
      (weekday === 1 || weekday === 2 ? active : rest).push(date);
    }
    const days = active.map((date) => day(date, 60));
    expect(grow(days, { restDates: rest }).fullnessLevel).toBeGreaterThan(grow(days).fullnessLevel);
  });

  it('expects fewer active days in a partial first month', () => {
    const days = spread(7 * HOUR, '2026-09-24', HOUR); // every day from the 24th
    expect(grow(days, { joinedOn: '2026-09-24' }).fullnessLevel).toBeGreaterThan(
      grow(days).fullnessLevel,
    );
  });

  it('follows the configured weights and levels', () => {
    const days = [day('2026-09-02', 60)];
    expect(
      grow(
        days,
        {},
        rulesWith({ 'growth.fullnessTargets': { activeDays: 1, activeDaysPerWeek: 1 } }),
      ).fullnessLevel,
    ).toBeGreaterThan(grow(days).fullnessLevel);
  });
});

describe('blossoms', () => {
  const someFocus = [day('2026-09-02', 60)];

  it.each([
    [0, 0, 0],
    [1, 0, 1],
    [2, 0, 1],
    [3, 0, 2],
    [0, 1, 1], // a weekly goal is worth 2 points
    [4, 1, 3],
    [27, 0, 6],
    [28, 0, 7],
    [200, 30, 7], // capped
  ])('%i daily + %i weekly goal completions → level %i', (daily, weekly, level) => {
    expect(grow(someFocus, { goalCompletions: { daily, weekly } }).blossomLevel).toBe(level);
  });

  it('follows the configured points and thresholds', () => {
    expect(
      grow(
        someFocus,
        { goalCompletions: { daily: 2, weekly: 0 } },
        rulesWith({ 'growth.blossomThresholds': [2, 4] }),
      ).blossomLevel,
    ).toBe(1);
    expect(
      grow(
        someFocus,
        { goalCompletions: { daily: 0, weekly: 1 } },
        rulesWith({ 'growth.blossomPoints': { dailyGoal: 1, weeklyGoal: 6 } }),
      ).blossomLevel,
    ).toBe(3);
  });
});

describe('richness', () => {
  it('is 0 before Final Form, however much growth there is', () => {
    const highFinal = rulesWith({ 'growth.stageThresholds': [120, 360, 720, 1200, 6000] });
    const days = spread(50 * HOUR, '2026-09-01');
    expect(grow(days, {}, highFinal).stage).toBe('blooming_tree');
    expect(grow(days, {}, highFinal).richnessTier).toBe(0);
  });

  it.each([
    [30 * HOUR, 0],
    [33 * HOUR - 1, 0],
    [33 * HOUR, 1],
    [36 * HOUR, 2],
    [40 * HOUR, 3],
    [45 * HOUR, 4],
    [51 * HOUR - 1, 4],
    [51 * HOUR, 5],
    [100 * HOUR, 5], // bounded at the top tier
  ])('%i ms of growth → tier %i', (growth, tier) => {
    const result = grow(spread(growth, '2026-09-01'));
    expect(result.stage).toBe('final_form');
    expect(result.richnessTier).toBe(tier);
  });

  it('keeps focus beyond the top tier in the statistics', () => {
    expect(grow(spread(100 * HOUR, '2026-09-01')).focusedMilliseconds).toBe(100 * HOUR);
  });
});

describe('monthly focus-hour milestone traits', () => {
  it.each([
    [10 * HOUR - 1, []],
    [10 * HOUR, ['monthly-focus-hours:10']],
    [25 * HOUR, ['monthly-focus-hours:10', 'monthly-focus-hours:25']],
    [60 * HOUR, ['monthly-focus-hours:10', 'monthly-focus-hours:25', 'monthly-focus-hours:40']],
  ])('%i ms of focus → %j', (focus, traits) => {
    expect(grow(spread(focus, '2026-09-01')).traitIds).toEqual(traits);
  });

  it('counts focused hours, not capped growth, and is not prorated', () => {
    const result = grow([day('2026-09-24', 10 * 60)], { joinedOn: '2026-09-24' });
    expect(result.growthMilliseconds).toBeLessThan(10 * HOUR);
    expect(result.traitIds).toEqual(['monthly-focus-hours:10']);
  });

  it('follows the configured milestones, without duplicates', () => {
    expect(
      grow(spread(6 * HOUR, '2026-09-01'), {}, rulesWith({ 'growth.focusHourMilestones': [5] }))
        .traitIds,
    ).toEqual(['monthly-focus-hours:5']);
  });
});

/**
 * docs/03_TREE_SYSTEM.md §15. The examples give totals, not daily detail, so the days below
 * are one plausible month for each.
 */
describe('example months (Tree System §15)', () => {
  const dates = (list: number[]) => list.map((d) => `2026-09-${String(d).padStart(2, '0')}`);

  // A: 3 h · 5 sessions · 4 active days · daily goal met twice.
  const exampleA = grow(
    [day('2026-09-01', 60, 2), day('2026-09-03', 40), day('2026-09-10', 40), day('2026-09-20', 40)],
    { goalCompletions: { daily: 2, weekly: 0 } },
  );
  // B: 15 h · 28 sessions · 20 active days · daily goal met 16 times · 3 planned rest days.
  const bDays = dates([1, 2, 3, 5, 7, 8, 10, 12, 14, 15, 16, 18, 21, 22, 24, 26, 28, 29, 30, 4]);
  const exampleB = grow(
    bDays.map((date, i) => day(date, 45, i < 8 ? 2 : 1)),
    { goalCompletions: { daily: 16, weekly: 0 }, restDates: dates([6, 13, 20]) },
  );
  // C: 32 h · 40 sessions · 14 active days in two bursts · daily goal met 12 times.
  const cDays = dates([7, 8, 9, 10, 11, 12, 13, 21, 22, 23, 24, 25, 26, 27]);
  const cMonth = cDays.map((date, i) => day(date, i === 0 ? 139 : 137, i < 12 ? 3 : 2));
  const exampleC = grow(cMonth, { goalCompletions: { daily: 12, weekly: 0 } });
  // D: 45 h · 60 sessions · 27 active days (every day but the three Sundays) · daily goal met 25 times.
  const dMonth = Array.from({ length: 30 }, (_, i) => i + 1)
    .filter((d) => ![6, 13, 20].includes(d))
    .map((d, i) => day(dates([d])[0] ?? '', 100, i < 6 ? 3 : 2));
  const exampleD = grow(dMonth, { goalCompletions: { daily: 25, weekly: 0 } });

  it('uses the stated totals', () => {
    expect(exampleA.focusedMilliseconds).toBe(3 * HOUR);
    expect(exampleA.activeDays).toBe(4);
    expect(exampleB.focusedMilliseconds).toBe(15 * HOUR);
    expect(exampleB.activeDays).toBe(20);
    expect(exampleC.focusedMilliseconds).toBe(32 * HOUR);
    expect(exampleC.activeDays).toBe(14);
    expect(exampleD.focusedMilliseconds).toBe(45 * HOUR);
    expect(exampleD.activeDays).toBe(27);
  });

  it('A, a very light month: a sparse Young Tree with a few blossoms', () => {
    expect(exampleA.stage).toBe('young_tree');
    expect(exampleA.fullnessLevel).toBeLessThanOrEqual(1);
    expect(exampleA.blossomLevel).toBeGreaterThanOrEqual(1);
    expect(exampleA.traitIds).toEqual([]);
    expect(exampleA.richnessTier).toBe(0);
  });

  it('B, a consistent moderate month: a Mature Tree, full for its size', () => {
    expect(exampleB.stage).toBe('mature_tree');
    expect(exampleB.fullnessLevel).toBeGreaterThanOrEqual(4);
    expect(exampleB.richnessTier).toBe(0);
  });

  it('C, a bursty high-focus month: Final Form but less full than B', () => {
    expect(exampleC.stage).toBe('final_form');
    expect(exampleC.fullnessLevel).toBeLessThan(exampleB.fullnessLevel);
    expect(exampleC.traitIds).toEqual(['monthly-focus-hours:10', 'monthly-focus-hours:25']);
  });

  it('D, a maximum month: Final Form, top fullness, abundant blossoms, every hour milestone', () => {
    expect(exampleD.stage).toBe('final_form');
    expect(exampleD.fullnessLevel).toBe(5);
    expect(exampleD.blossomLevel).toBeGreaterThan(exampleB.blossomLevel);
    expect(exampleD.traitIds).toHaveLength(3);
  });

  it('orders blossoms by goal completions: A < C < B < D', () => {
    expect(exampleA.blossomLevel).toBeLessThan(exampleC.blossomLevel);
    expect(exampleC.blossomLevel).toBeLessThan(exampleB.blossomLevel);
    expect(exampleB.blossomLevel).toBeLessThan(exampleD.blossomLevel);
  });

  // The docs show C at richness tier 1 and D at the top tier. The approved richness
  // thresholds (+3 / 6 / 10 / 15 / 21 h) give C none (+2 h) and D tier 4 (+15 h).
  it('with the approved richness thresholds, C has no richness yet and D reaches tier 4', () => {
    expect(exampleC.richnessTier).toBe(0);
    expect(exampleD.richnessTier).toBe(4);
  });

  it('matches the documented richness of C and D with other thresholds, no code change', () => {
    const tighter = rulesWith({ 'growth.richnessTiers': [120, 240, 420, 660, 900] });
    const c = grow(cMonth, {}, tighter);
    const d = grow(dMonth, {}, tighter);
    expect(c.richnessTier).toBe(1);
    expect(d.richnessTier).toBe(5);
  });
});
