import type { TreeStateDto } from '../../src/trees/tree.contracts.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';
import { MonthSimulation, type MonthPlan } from '../support/month-simulation.js';

/**
 * The Tree System example months (docs/03_TREE_SYSTEM.md §15), lived through the API with the
 * month simulation, then closed. Each month's numbers must agree everywhere they appear:
 * History, the tree, Home, Insights, records, the archive, and the recap. Tree shapes follow the
 * approved configuration, not the docs' illustrative richness.
 */

const MIN = 60_000;
const t = new ConsistencyHarness('2026-08-31T20:00:00.000Z');
const simulation = new MonthSimulation(t);

type User = Awaited<ReturnType<typeof t.signUp>>;

const sept = (day: number) => `2026-09-${String(day).padStart(2, '0')}`;

/** A: 3 h · 5 sessions · 4 active days · daily goal (45 min) met twice · longest streak 2. */
const A: MonthPlan = {
  year: 2026,
  month: 9,
  dailyGoalMinutes: 45,
  days: [
    { date: sept(1), sessions: [30, 30] },
    { date: sept(2), sessions: [50] },
    { date: sept(10), sessions: [35] },
    { date: sept(20), sessions: [35] },
  ],
};

/** B: 15 h · 28 sessions · 20 active days · three planned rest days (Sundays). */
const B: MonthPlan = {
  year: 2026,
  month: 9,
  dailyGoalMinutes: 45,
  restDays: [sept(6), sept(13), sept(20)],
  days: [1, 2, 3, 4, 5, 7, 8, 10, 12, 14, 15, 16, 18, 21, 22, 24, 26, 28, 29, 30].map((day, i) => ({
    date: sept(day),
    sessions: i < 8 ? [20, 25] : [45],
  })),
};

/** C: 32 h · 40 sessions · 14 active days in two bursts. */
const C: MonthPlan = {
  year: 2026,
  month: 9,
  dailyGoalMinutes: 120,
  days: [7, 8, 9, 10, 11, 12, 13, 21, 22, 23, 24, 25, 26, 27].map((day, i) => ({
    date: sept(day),
    sessions: i === 0 ? [47, 46, 46] : i < 12 ? [46, 46, 45] : [69, 68],
  })),
};

/** D: 45 h · 60 sessions · 27 active days (every day but the first three Sundays). */
const D: MonthPlan = {
  year: 2026,
  month: 9,
  dailyGoalMinutes: 90,
  days: Array.from({ length: 30 }, (_, i) => i + 1)
    .filter((day) => ![6, 13, 20].includes(day))
    .map((day, i) => ({ date: sept(day), sessions: i < 6 ? [34, 33, 33] : [50, 50] })),
};

interface Outcome {
  tree: TreeStateDto;
}

describe('example months A–D across every query surface (HTTP + PostgreSQL)', () => {
  const outcomes: Record<string, Outcome> = {};

  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-08-31T20:00:00.000Z');
    await t.activateConfig();
  });

  const get = async <T>(user: User, path: string) =>
    (await t.http().get(path).set(user.auth).expect(200)).body as T;

  /** Lives the month, closes it, and checks that every surface tells the same story. */
  async function characterize(name: string, plan: MonthPlan): Promise<Outcome> {
    const user = await t.signUp(`${name}@example.com`);
    await simulation.live(user, plan);
    const sessions = plan.days.flatMap((day) => day.sessions);
    const totalMinutes = sessions.reduce((sum, minutes) => sum + minutes, 0);

    // The last evening of the month: Home shows the tree that will be archived.
    const growing = (await get<{ tree: TreeStateDto }>(user, '/me/home')).tree;
    expect(growing).toMatchObject({ year: 2026, month: 9, status: 'growing' });

    const home = await simulation.openNextMonth(user, 2026, 9);
    expect(home.tree).toMatchObject({ year: 2026, month: 10 });
    expect(home.pendingCeremony).toEqual({ year: 2026, month: 9 });

    // History holds every session of the month.
    const history = await get<{ items: { focusedMilliseconds: number; counted: boolean }[] }>(
      user,
      '/me/sessions?month=2026-09&limit=100',
    );
    expect(history.items).toHaveLength(sessions.length);
    const historyMs = history.items
      .filter((item) => item.counted)
      .reduce((sum, item) => sum + item.focusedMilliseconds, 0);
    expect(historyMs).toBe(totalMinutes * MIN);

    // The archive froze what Home showed, with the month's numbers.
    const details = await get<{ tree: TreeStateDto; stats: Record<string, unknown> }>(
      user,
      '/me/trees/2026/9',
    );
    expect(details.tree).toEqual({ ...growing, status: 'archived', vitality: null });
    expect(details.stats).toMatchObject({
      focusedMinutes: totalMinutes,
      sessionCount: sessions.length,
      activeDays: plan.days.length,
    });

    // Insights (from sessions) agree with the archive; the recap with both.
    const insights = await get<{
      summary: { focusedMilliseconds: number; sessionCount: number; activeDays: number };
      goals: { daily: { completed: number } };
      days: { dailyGoal: string }[];
      mostProductiveDay: unknown;
      mostProductiveWeek: unknown;
      archivedStats: unknown;
    }>(user, '/me/insights/month?year=2026&month=9');
    expect(insights.summary).toMatchObject({
      focusedMilliseconds: totalMinutes * MIN,
      sessionCount: sessions.length,
      activeDays: plan.days.length,
    });
    expect(insights.archivedStats).toEqual(details.stats);
    expect(insights.goals.daily.completed).toBe(details.stats['dailyGoalsMet']);
    expect(insights.days.filter((cell) => cell.dailyGoal === 'met')).toHaveLength(
      details.stats['dailyGoalsMet'] as number,
    );
    const recap = await get<{
      stats: unknown;
      mostProductiveDay: unknown;
      mostProductiveWeek: unknown;
      newRecords: { kind: string; value: number }[];
    }>(user, '/me/trees/2026/9/recap');
    expect(recap.stats).toEqual(details.stats);
    expect(recap.mostProductiveDay).toEqual(insights.mostProductiveDay);
    expect(recap.mostProductiveWeek).toEqual(insights.mostProductiveWeek);

    // A first month sets its records; lifetime numbers are the month's.
    const month = (list: { kind: string; value: number }[]) =>
      list.find((record) => record.kind === 'most_focused_month')?.value;
    expect(month(recap.newRecords)).toBe(totalMinutes);
    expect(
      month(
        (await get<{ records: { kind: string; value: number }[] }>(user, '/me/insights/records'))
          .records,
      ),
    ).toBe(totalMinutes);
    expect(await get(user, '/me/profile/stats')).toMatchObject({
      focusedMilliseconds: totalMinutes * MIN,
      sessionCount: sessions.length,
      archivedTreeCount: 1,
    });

    outcomes[name] = { tree: details.tree };
    return outcomes[name];
  }

  it('A, a very light month: a Young Tree, no traits, daily goal met twice', async () => {
    const { tree } = await characterize('a', A);
    expect(tree.progress).toMatchObject({ stage: 'young_tree', richness: { tier: 0 } });
    expect(tree.progress.fullness.level).toBeLessThanOrEqual(1);
    expect(tree.traits).toEqual([]);
  }, 300_000);

  it('B, a consistent moderate month: a Mature Tree, full for its size', async () => {
    const { tree } = await characterize('b', B);
    expect(tree.progress.stage).toBe('mature_tree');
    expect(tree.progress.fullness.level).toBeGreaterThanOrEqual(4);
    expect(tree.traits.map((trait) => trait.id)).toContain('streak-days:3');
  }, 300_000);

  it('C, a bursty high-focus month: Final Form, less full than B', async () => {
    const { tree } = await characterize('c', C);
    expect(tree.progress.stage).toBe('final_form');
    expect(tree.progress.fullness.level).toBeLessThan(
      outcomes['b']?.tree.progress.fullness.level ?? 0,
    );
    expect(tree.traits.map((trait) => trait.id)).toEqual(
      expect.arrayContaining(['monthly-focus-hours:10', 'monthly-focus-hours:25']),
    );
  }, 300_000);

  it('D, a maximum month: Final Form, top fullness, more blossoms than B', async () => {
    const { tree } = await characterize('d', D);
    expect(tree.progress.stage).toBe('final_form');
    expect(tree.progress.fullness.level).toBe(5);
    expect(tree.progress.blossoms.level).toBeGreaterThan(
      outcomes['b']?.tree.progress.blossoms.level ?? Infinity,
    );
  }, 300_000);
});
