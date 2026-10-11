import {
  addDays,
  firstDateOfMonth,
  lastDateOfMonth,
  weekStartOf,
  type LocalDate,
} from '../common/local-date.js';

/**
 * A5.8 Leaderboards (spec §16.4, docs/02 Leaderboards, docs/06 Leaderboard). Pure. The fair score
 * blends consistency, goal completion, active days, and focus time, so people with less free time
 * can still do well: it never ranks raw hours alone.
 */

export interface ScoreWeights {
  consistency: number;
  goals: number;
  activeDays: number;
  focusTime: number;
}

export interface ScoreInput {
  /** The local days of the period. */
  periodDays: number;
  /** Days kept: active, a planned rest day, or recovered. Rest is never a penalty. */
  keptDays: number;
  /** Days the daily goal in effect was met. */
  goalMetDays: number;
  /** Counted focus minutes of each active day. */
  dailyMinutes: readonly number[];
}

/** The score, 0 to 1000. The daily cap keeps one very long day from dominating. */
export function fairScore(
  input: ScoreInput,
  weights: ScoreWeights,
  dailyCapMinutes: number,
): number {
  const total = weights.consistency + weights.goals + weights.activeDays + weights.focusTime;
  if (total === 0 || input.periodDays === 0) return 0;
  const capped = input.dailyMinutes.reduce(
    (sum, minutes) => sum + Math.min(minutes, dailyCapMinutes),
    0,
  );
  const blended =
    weights.consistency * (input.keptDays / input.periodDays) +
    weights.goals * (input.goalMetDays / input.periodDays) +
    weights.activeDays * (input.dailyMinutes.length / input.periodDays) +
    weights.focusTime * (capped / (dailyCapMinutes * input.periodDays));
  return Math.round((1000 * blended) / total);
}

/** Why the weights cannot be used, or null: never focus time alone (spec §16.4), never nothing. */
export function weightsProblem(weights: ScoreWeights): string | null {
  if (weights.consistency + weights.goals + weights.activeDays === 0) {
    return weights.focusTime === 0
      ? 'at least one weight must be above zero'
      : 'focus time must never be the only weight';
  }
  return null;
}

/** Score descending; ties share a rank (1, 2, 2, 4) and are listed by name, then id. */
export function rankRows<T extends { id: string; name: string; score: number }>(
  rows: readonly T[],
): (T & { rank: number })[] {
  const sorted = [...rows].sort(
    (a, b) => b.score - a.score || compare(a.name, b.name) || compare(a.id, b.id),
  );
  let rank = 0;
  return sorted.map((row, i) => {
    if (i === 0 || row.score !== sorted[i - 1]!.score) rank = i + 1;
    return { ...row, rank };
  });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface Period {
  startDate: LocalDate;
  endDate: LocalDate;
}

/** The week from Monday holding `today`. */
export function weekPeriod(today: LocalDate): Period {
  const startDate = weekStartOf(today);
  return { startDate, endDate: addDays(startDate, 6) };
}

/** The calendar month holding `today`. */
export function monthPeriod(today: LocalDate): Period {
  const [year = 0, month = 1] = today.split('-').map(Number);
  return {
    startDate: firstDateOfMonth({ year, month }),
    endDate: lastDateOfMonth({ year, month }),
  };
}
