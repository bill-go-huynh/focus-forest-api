/**
 * A7.3 Leaderboard integrity, pure (Phase 7 owner decision 8: flags for staff to look at, never
 * an automatic exclusion; focus that only looks unusual must never be punished). Each flag has a
 * stable key, so a flag staff dismissed does not come back for the same evidence.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The weeks before a week that say what is usual for the person. */
const USUAL_WEEKS = 4;

/** A counted session, as stored. */
export interface IntegritySession {
  id: string;
  /** The session's local date (YYYY-MM-DD). */
  localDate: string;
  startedAt: Date;
  endedAt: Date;
  focusedMilliseconds: number;
  /** When the server stored it. */
  submittedAt: Date;
}

export interface IntegrityRules {
  maxDailyFocusMinutes: number;
  lateSubmissionHours: number;
  spike: { ratio: number; minMinutes: number };
}

export type IntegrityFlag =
  | {
      kind: 'overlap';
      key: string;
      detail: { sessionIds: [string, string]; overlapMinutes: number };
    }
  | { kind: 'day_total'; key: string; detail: { localDate: string; focusMinutes: number } }
  | { kind: 'late'; key: string; detail: { sessionId: string; hoursLate: number } }
  | {
      kind: 'spike';
      key: string;
      detail: { weekStart: string; focusMinutes: number; usualMinutes: number };
    };

const minutes = (ms: number) => Math.floor(ms / MIN);

/** The Monday of a local date's week. */
function weekStart(localDate: string): string {
  const day = new Date(`${localDate}T00:00:00Z`);
  const back = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - back * DAY).toISOString().slice(0, 10);
}

/** Every flag in one person's counted sessions, in a stable order. */
export function integrityFlags(
  sessions: readonly IntegritySession[],
  rules: IntegrityRules,
): IntegrityFlag[] {
  const sorted = [...sessions].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id),
  );
  const flags: IntegrityFlag[] = [];

  // One timer at a time: two sessions cannot run at once.
  sorted.forEach((a, i) => {
    for (const b of sorted.slice(i + 1)) {
      if (b.startedAt >= a.endedAt) break;
      const overlap = Math.min(a.endedAt.getTime(), b.endedAt.getTime()) - b.startedAt.getTime();
      flags.push({
        kind: 'overlap',
        key: `overlap:${a.id}:${b.id}`,
        detail: { sessionIds: [a.id, b.id], overlapMinutes: minutes(overlap) },
      });
    }
  });

  const byDay = new Map<string, number>();
  for (const s of sorted)
    byDay.set(s.localDate, (byDay.get(s.localDate) ?? 0) + s.focusedMilliseconds);
  for (const [localDate, ms] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    if (minutes(ms) > rules.maxDailyFocusMinutes) {
      flags.push({
        kind: 'day_total',
        key: `day:${localDate}`,
        detail: { localDate, focusMinutes: minutes(ms) },
      });
    }
  }

  // The app syncs sessions kept offline later; days later is no longer syncing.
  for (const s of sorted) {
    const late = s.submittedAt.getTime() - s.endedAt.getTime();
    if (late > rules.lateSubmissionHours * HOUR) {
      flags.push({
        kind: 'late',
        key: `late:${s.id}`,
        detail: { sessionId: s.id, hoursLate: Math.floor(late / HOUR) },
      });
    }
  }

  const byWeek = new Map<string, number>();
  for (const s of sorted) {
    const week = weekStart(s.localDate);
    byWeek.set(week, (byWeek.get(week) ?? 0) + s.focusedMilliseconds);
  }
  for (const [week, ms] of [...byWeek].sort(([a], [b]) => a.localeCompare(b))) {
    const before = Array.from({ length: USUAL_WEEKS }, (_, i) =>
      new Date(Date.parse(`${week}T00:00:00Z`) - (i + 1) * 7 * DAY).toISOString().slice(0, 10),
    );
    // Nothing usual yet (a first busy week) is never a spike.
    if (!before.some((w) => byWeek.has(w))) continue;
    const usual = before.reduce((sum, w) => sum + (byWeek.get(w) ?? 0), 0) / USUAL_WEEKS;
    const focus = minutes(ms);
    if (focus >= rules.spike.minMinutes && focus >= rules.spike.ratio * minutes(usual)) {
      flags.push({
        kind: 'spike',
        key: `spike:${week}`,
        detail: { weekStart: week, focusMinutes: focus, usualMinutes: minutes(usual) },
      });
    }
  }
  return flags;
}
