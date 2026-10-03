import { addDays, compareLocalDates, type LocalDate } from '../common/local-date.js';
import { streakTraitId } from '../trees/traits.js';

/**
 * The streak (docs/06_DOMAIN_MODEL.md → Streak): consecutive days with at least one counted
 * session. The number is the count of active days in the connected run: planned rest days and
 * recovered days bridge the run without adding to it. A rest day with focus is still a rest day
 * for the streak. Today, until it ends, neither breaks nor extends it.
 */

export interface ActivityHistory {
  /** Dates with at least one counted session. */
  activeDates: readonly LocalDate[];
  restDates: readonly LocalDate[];
  /** Missed dates repaired by a streak recovery. */
  recoveredDates: readonly LocalDate[];
}

export type StreakDay = 'active' | 'rest' | 'recovered' | 'missed';

export interface StreakSummary {
  current: number;
  longest: number;
  /** How today stands so far; "pending" until it has focus or is a rest day. */
  today: 'active' | 'rest' | 'pending';
}

export interface StreakMilestoneEvent {
  days: number;
  /** The day the run reached this many active days. */
  date: LocalDate;
  traitId: string;
}

class Days {
  private readonly active: ReadonlySet<LocalDate>;
  private readonly rest: ReadonlySet<LocalDate>;
  private readonly recovered: ReadonlySet<LocalDate>;
  /** The earliest date that is anything but missed; null when there is none. */
  readonly first: LocalDate | null;

  constructor(history: ActivityHistory) {
    this.active = new Set(history.activeDates);
    this.rest = new Set(history.restDates);
    this.recovered = new Set(history.recoveredDates);
    const all = [...history.activeDates, ...history.restDates, ...history.recoveredDates];
    this.first =
      all.length === 0 ? null : all.reduce((a, b) => (compareLocalDates(a, b) <= 0 ? a : b));
  }

  status(date: LocalDate): StreakDay {
    if (this.rest.has(date)) return 'rest';
    if (this.active.has(date)) return 'active';
    if (this.recovered.has(date)) return 'recovered';
    return 'missed';
  }
}

export function summarizeStreak(history: ActivityHistory, today: LocalDate): StreakSummary {
  const days = new Days(history);
  const todayStatus = days.status(today);
  const todayState = todayStatus === 'active' || todayStatus === 'rest' ? todayStatus : 'pending';

  // Today without focus yet does not end the streak: count back from yesterday.
  const end = todayState === 'pending' ? addDays(today, -1) : today;
  return { current: runEndingOn(days, end), longest: longestRun(days, today), today: todayState };
}

/** Active days in the run that ends on `date` (0 when `date` was missed). */
export function streakEndingOn(history: ActivityHistory, date: LocalDate): number {
  return runEndingOn(new Days(history), date);
}

function runEndingOn(days: Days, end: LocalDate): number {
  if (!days.first) return 0;
  let count = 0;
  for (let date = end; compareLocalDates(date, days.first) >= 0; date = addDays(date, -1)) {
    const status = days.status(date);
    if (status === 'missed') break;
    if (status === 'active') count += 1;
  }
  return count;
}

function longestRun(days: Days, today: LocalDate): number {
  let longest = 0;
  forEachRunDay(days, today, (count) => {
    longest = Math.max(longest, count);
  });
  return longest;
}

/** Calls `visit` for every day from the first to today with the run's active count so far. */
function forEachRunDay(
  days: Days,
  today: LocalDate,
  visit: (count: number, date: LocalDate, status: StreakDay) => void,
): void {
  if (!days.first) return;
  let count = 0;
  for (let date = days.first; compareLocalDates(date, today) <= 0; date = addDays(date, 1)) {
    const status = days.status(date);
    if (status === 'missed') {
      // Today is still in progress: it cannot break the run.
      if (date !== today) count = 0;
    } else if (status === 'active') {
      count += 1;
    }
    visit(count, date, status);
  }
}

/**
 * When each streak milestone was reached, up to today: once per run, on the active day the run
 * reached that length. Feeds the `streak-days:N` traits of the month containing `date`.
 */
export function streakMilestoneEvents(
  history: ActivityHistory,
  today: LocalDate,
  milestones: readonly number[],
): StreakMilestoneEvent[] {
  const lengths = [...new Set(milestones)];
  const events: StreakMilestoneEvent[] = [];
  forEachRunDay(new Days(history), today, (count, date, status) => {
    if (status !== 'active') return;
    for (const days of lengths) {
      if (count === days) events.push({ days, date, traitId: streakTraitId(days) });
    }
  });
  return events;
}
