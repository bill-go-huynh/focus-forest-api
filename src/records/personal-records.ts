import { addDays, compareLocalDates, weekStartOf, type LocalDate } from '../common/local-date.js';
import { streakRunDays, type ActivityHistory } from '../consistency/streak.js';
import type { DayFocus } from '../focus-stats/focus-stats.js';

/**
 * Personal records (docs/06_DOMAIN_MODEL.md → PersonalRecord, spec §7.5), computed from stored
 * truth up to a date. Pure, so a recap can tell which records its month set, and Insights (A3.5)
 * can show the same records. Only bests: there is never a negative record.
 */

const MINUTE_MS = 60_000;

/** In this order everywhere. */
export const PERSONAL_RECORD_KINDS = [
  'most_focused_day',
  'most_focused_week',
  'most_focused_month',
  'longest_streak',
  'longest_session',
  'longest_daily_goal_streak',
] as const;
export type PersonalRecordKind = (typeof PERSONAL_RECORD_KINDS)[number];

export interface PersonalRecord {
  kind: PersonalRecordKind;
  /** Whole minutes for focus records, days for streaks. */
  value: number;
  unit: 'minutes' | 'days';
  /**
   * When it was achieved: the day; the Monday of the week; the first day of the month; the day a
   * streak reached its length; the day of the session.
   */
  achievedOn: LocalDate;
}

export interface RecordsInput {
  /** Counted focus per local date. */
  days: readonly DayFocus[];
  /** The longest counted session of each local date. */
  longestSessions: readonly { date: LocalDate; focusedMilliseconds: number }[];
  activity: ActivityHistory;
  /** Dates whose daily goal was met. */
  goalMetDates: readonly LocalDate[];
}

const UNITS: Record<PersonalRecordKind, PersonalRecord['unit']> = {
  most_focused_day: 'minutes',
  most_focused_week: 'minutes',
  most_focused_month: 'minutes',
  longest_streak: 'days',
  longest_session: 'minutes',
  longest_daily_goal_streak: 'days',
};

/** A best in exact units (milliseconds or days), so records compare without rounding. */
interface Best {
  amount: number;
  achievedOn: LocalDate;
}

/** The user's records counting only what happened on or before `until`; none without focus. */
export function personalRecords(input: RecordsInput, until: LocalDate): PersonalRecord[] {
  const bests = bestsUntil(input, until);
  return PERSONAL_RECORD_KINDS.flatMap((kind) => {
    const best = bests[kind];
    return best ? [toRecord(kind, best)] : [];
  });
}

/**
 * The records set in [from, to]: each best up to `to` that is strictly greater than the best
 * before `from`. A first period with focus sets every record it has.
 */
export function newPersonalRecords(
  input: RecordsInput,
  period: { from: LocalDate; to: LocalDate },
): PersonalRecord[] {
  const before = bestsUntil(input, addDays(period.from, -1));
  const after = bestsUntil(input, period.to);
  return PERSONAL_RECORD_KINDS.flatMap((kind) => {
    const best = after[kind];
    if (!best || best.amount <= (before[kind]?.amount ?? 0)) return [];
    return [toRecord(kind, best)];
  });
}

function toRecord(kind: PersonalRecordKind, best: Best): PersonalRecord {
  const unit = UNITS[kind];
  const value = unit === 'minutes' ? Math.floor(best.amount / MINUTE_MS) : best.amount;
  return { kind, value, unit, achievedOn: best.achievedOn };
}

function bestsUntil(
  input: RecordsInput,
  until: LocalDate,
): Partial<Record<PersonalRecordKind, Best>> {
  const upTo = <T extends { date: LocalDate }>(items: readonly T[]) =>
    items
      .filter((item) => compareLocalDates(item.date, until) <= 0)
      .sort((a, b) => compareLocalDates(a.date, b.date));
  const days = upTo(input.days).filter((day) => day.focusedMilliseconds > 0);

  return {
    most_focused_day: highest(days.map((day) => [day.date, day.focusedMilliseconds])),
    most_focused_week: highest(totals(days, (date) => weekStartOf(date))),
    most_focused_month: highest(totals(days, (date) => `${date.slice(0, 7)}-01`)),
    longest_streak: highest(
      streakRunDays(input.activity, until).map(({ date, count }) => [date, count]),
    ),
    longest_session: highest(
      upTo(input.longestSessions).map((session) => [session.date, session.focusedMilliseconds]),
    ),
    longest_daily_goal_streak: highest(
      goalRuns(input.goalMetDates, input.activity.restDates, until),
    ),
  };
}

/** The first [date, amount] with the greatest positive amount: earliest wins a tie. */
function highest(entries: readonly (readonly [LocalDate, number])[]): Best | undefined {
  let best: Best | undefined;
  for (const [achievedOn, amount] of entries) {
    if (amount > 0 && (!best || amount > best.amount)) best = { amount, achievedOn };
  }
  return best;
}

/** Focus summed per period key (in date order), as [key, total] entries. */
function totals(
  days: readonly DayFocus[],
  keyOf: (date: LocalDate) => LocalDate,
): [LocalDate, number][] {
  const sums = new Map<LocalDate, number>();
  for (const day of days) {
    const key = keyOf(day.date);
    sums.set(key, (sums.get(key) ?? 0) + day.focusedMilliseconds);
  }
  return [...sums];
}

/**
 * For each met date up to `until`, the length of the daily-goal run ending on it: consecutive
 * met dates, where planned rest days in between bridge the run without adding to it (Phase 3
 * decision). Anything else, a recovered day included, ends the run.
 */
function goalRuns(
  dates: readonly LocalDate[],
  restDates: readonly LocalDate[],
  until: LocalDate,
): [LocalDate, number][] {
  const rest = new Set(restDates);
  const sorted = [...new Set(dates)]
    .filter((date) => compareLocalDates(date, until) <= 0)
    .sort(compareLocalDates);
  const runs: [LocalDate, number][] = [];
  let previous: LocalDate | null = null;
  let length = 0;
  for (const date of sorted) {
    length = previous !== null && bridged(previous, date, rest) ? length + 1 : 1;
    runs.push([date, length]);
    previous = date;
  }
  return runs;
}

/** Whether every day strictly between `from` and `to` is a planned rest day. */
function bridged(from: LocalDate, to: LocalDate, rest: ReadonlySet<LocalDate>): boolean {
  for (let date = addDays(from, 1); date !== to; date = addDays(date, 1)) {
    if (!rest.has(date)) return false;
  }
  return true;
}
