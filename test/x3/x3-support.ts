import {
  addDays,
  compareLocalDates,
  weekStartOf,
  type LocalDate,
} from '../../src/common/local-date.js';
import type { TreeStateDto } from '../../src/trees/tree.contracts.js';
import type { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * X3 (Core Loop integration) test helpers. Expected numbers are derived here, in the test, from
 * the session rows the API returns (History), never by importing the production aggregation, so
 * a check compares two independent computations of the same truth.
 */

export const MIN = 60_000;

/** A fixed, valid UUID per number, so a scenario's session ids are stable. */
export const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export type X3User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

export interface HistoryRow {
  id: string;
  topicId: string;
  startedAt: string;
  focusedMilliseconds: number;
  status: string;
  counted: boolean;
  localDate: LocalDate;
  year: number;
  month: number;
  note: string | null;
  topic: { id: string; name: string; status: string };
}

export async function get<T = Record<string, unknown>>(
  t: ConsistencyHarness,
  user: X3User,
  path: string,
  status = 200,
): Promise<T> {
  return (await t.http().get(path).set(user.auth).expect(status)).body as T;
}

/** Every History row matching `query`, following the cursor (newest first). */
export async function allHistory(
  t: ConsistencyHarness,
  user: X3User,
  query = '',
): Promise<HistoryRow[]> {
  const rows: HistoryRow[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams(query);
    params.set('limit', '100');
    if (cursor) params.set('cursor', cursor);
    const page: { items: HistoryRow[]; nextCursor: string | null } = await get(
      t,
      user,
      `/me/sessions?${params.toString()}`,
    );
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

/** A period's numbers recomputed from its rows: counted sessions only, discarded ones visible. */
export function summarize(rows: readonly HistoryRow[]) {
  const counted = rows.filter((row) => row.counted);
  const topics = new Map<string, { focusedMilliseconds: number; sessionCount: number }>();
  for (const row of counted) {
    const entry = topics.get(row.topicId) ?? { focusedMilliseconds: 0, sessionCount: 0 };
    entry.focusedMilliseconds += row.focusedMilliseconds;
    entry.sessionCount += 1;
    topics.set(row.topicId, entry);
  }
  const byDate = new Map<LocalDate, number>();
  for (const row of counted) {
    byDate.set(row.localDate, (byDate.get(row.localDate) ?? 0) + row.focusedMilliseconds);
  }
  return {
    focusedMilliseconds: counted.reduce((sum, row) => sum + row.focusedMilliseconds, 0),
    sessionCount: counted.length,
    activeDays: byDate.size,
    byDate,
    topics,
    longestMilliseconds: Math.max(0, ...counted.map((row) => row.focusedMilliseconds)),
    discarded: rows.filter((row) => !row.counted).length,
  };
}

/** The first [key, amount] with the greatest amount: an equal amount later never replaces it. */
function earliestBest(entries: readonly (readonly [LocalDate, number])[]) {
  let best: { achievedOn: LocalDate; amount: number } | null = null;
  for (const [achievedOn, amount] of [...entries].sort((a, b) => compareLocalDates(a[0], b[0]))) {
    if (amount > 0 && (!best || amount > best.amount)) best = { achievedOn, amount };
  }
  return best;
}

/**
 * The six personal records recomputed from History rows and the scenario's own plan (its rest
 * days, recovered days, and daily goal): an independent reading of the documented rules.
 */
export function expectedRecords(
  rows: readonly HistoryRow[],
  plan: { restDates: LocalDate[]; recoveredDates: LocalDate[]; dailyGoalMinutes: number },
) {
  const { byDate } = summarize(rows);
  const sumBy = (key: (date: LocalDate) => LocalDate) => {
    const sums = new Map<LocalDate, number>();
    for (const [date, ms] of byDate) sums.set(key(date), (sums.get(key(date)) ?? 0) + ms);
    return [...sums];
  };
  const dates = [...byDate.keys()].sort(compareLocalDates);
  const rest = new Set(plan.restDates);
  const recovered = new Set(plan.recoveredDates);

  // Focus streak: active days count; rest and recovered days bridge without counting.
  const streakRuns: [LocalDate, number][] = [];
  if (dates.length > 0) {
    let run = 0;
    for (
      let date = dates[0]!;
      compareLocalDates(date, dates.at(-1)!) <= 0;
      date = addDays(date, 1)
    ) {
      if (byDate.has(date)) run += 1;
      else if (!rest.has(date) && !recovered.has(date)) run = 0;
      if (byDate.has(date)) streakRuns.push([date, run]);
    }
  }
  // Daily-goal streak: met days count; only planned rest days bridge.
  const goalRuns: [LocalDate, number][] = [];
  const met = dates.filter((date) => (byDate.get(date) ?? 0) >= plan.dailyGoalMinutes * MIN);
  let goalRun = 0;
  met.forEach((date, i) => {
    const previous = met[i - 1];
    let bridged = previous !== undefined;
    if (previous !== undefined) {
      for (let d = addDays(previous, 1); d !== date; d = addDays(d, 1)) {
        if (!rest.has(d)) bridged = false;
      }
    }
    goalRun = bridged ? goalRun + 1 : 1;
    goalRuns.push([date, goalRun]);
  });

  const longestByDate = new Map<LocalDate, number>();
  for (const row of rows.filter((r) => r.counted)) {
    longestByDate.set(
      row.localDate,
      Math.max(longestByDate.get(row.localDate) ?? 0, row.focusedMilliseconds),
    );
  }

  const minutes = (best: { achievedOn: LocalDate; amount: number } | null) =>
    best && { value: Math.floor(best.amount / MIN), achievedOn: best.achievedOn };
  const days = (best: { achievedOn: LocalDate; amount: number } | null) =>
    best && { value: best.amount, achievedOn: best.achievedOn };
  return {
    most_focused_day: minutes(earliestBest([...byDate])),
    most_focused_week: minutes(earliestBest(sumBy((date) => weekStartOf(date)))),
    most_focused_month: minutes(earliestBest(sumBy((date) => `${date.slice(0, 7)}-01`))),
    longest_streak: days(earliestBest(streakRuns)),
    longest_session: minutes(earliestBest([...longestByDate])),
    longest_daily_goal_streak: days(earliestBest(goalRuns)),
  };
}

/** The records an endpoint returned, keyed by kind. */
export const recordsByKind = (records: { kind: string; value: number; achievedOn: string }[]) =>
  Object.fromEntries(
    records.map((record) => [record.kind, { value: record.value, achievedOn: record.achievedOn }]),
  );

const ids = (tree: TreeStateDto) => tree.traits.map((trait) => trait.id);

/** What a tree has earned never goes down within its month; vitality may. */
export function expectNeverLower(before: TreeStateDto, after: TreeStateDto): void {
  expect([after.year, after.month]).toEqual([before.year, before.month]);
  expect(after.progress.stageNumber).toBeGreaterThanOrEqual(before.progress.stageNumber);
  expect(after.progress.fullness.level).toBeGreaterThanOrEqual(before.progress.fullness.level);
  expect(after.progress.blossoms.level).toBeGreaterThanOrEqual(before.progress.blossoms.level);
  expect(after.progress.richness.tier).toBeGreaterThanOrEqual(before.progress.richness.tier);
  expect(after.progress.growthMinutes).toBeGreaterThanOrEqual(before.progress.growthMinutes);
  expect(ids(after)).toEqual(expect.arrayContaining(ids(before)));
  expect(after.variationSeed).toBe(before.variationSeed);
  expect(after.configVersion).toBe(before.configVersion);
}

/** Everything an archived month holds in the database, to compare before and after. */
export async function frozenMonth(
  t: ConsistencyHarness,
  userId: string,
  year: number,
  month: number,
) {
  const key = { userId_year_month: { userId, year, month } };
  const context = await t.prisma.monthAttributionContext.findUnique({ where: key });
  return {
    tree: await t.prisma.monthlyTree.findUnique({ where: key }),
    traits: await t.prisma.monthlyTreeTrait.findMany({
      where: { userId, year, month },
      orderBy: { traitId: 'asc' },
    }),
    recap: await t.prisma.monthlyRecap.findUnique({ where: key }),
    closedAt: context?.closedAt ?? null,
    timezone: context?.timezone ?? null,
  };
}

/** Archived month data as the API serves it: Tree Details, the recap, and its forest item. */
export async function servedMonth(
  t: ConsistencyHarness,
  user: X3User,
  year: number,
  month: number,
) {
  const forest = await get<{ items: { year: number; month: number }[] }>(
    t,
    user,
    '/me/forest?limit=60',
  );
  return {
    details: await get(t, user, `/me/trees/${year}/${month}`),
    recap: await get(t, user, `/me/trees/${year}/${month}/recap`),
    forestItem: forest.items.find((item) => item.year === year && item.month === month),
  };
}

const VITALITY_ORDER = ['recovering', 'quiet', 'stable', 'healthy', 'thriving'];
export const vitalityRank = (vitality: string | null) => VITALITY_ORDER.indexOf(vitality ?? '');
