/**
 * DM.1 The demo world's histories (spec/demo/PLAN.md), as local dates and times in the
 * presenter's time zone. Pure: the service turns them into sessions.
 *
 * - Main presenter: an August tree of 600 minutes (archived when the world is made), a September
 *   tree of 1,680 (left to close on the first app open: the planting ceremony and recap), and
 *   715 minutes this month; 2,995 in all. A 6-day streak ends yesterday; no run anywhere reaches
 *   7. So one 5-minute session, the shortest that counts, makes a Mature Tree (720), passes 50
 *   hours (3,000) and makes the streak 7: the presenter shows it live (owner, 2026-10-22).
 * - Comeback presenter: nothing for the last 3 days (Resting quietly; a session wakes it).
 * - Recovery presenter: 4 days in a row, then yesterday missed (a session today opens the offer).
 * - Three friends: together 290 minutes yesterday, the Community Tree's backfill.
 */

export interface PlannedSession {
  /** "YYYY-MM-DD", local. */
  localDate: string;
  startHour: number;
  startMinute: number;
  minutes: number;
}

export interface WorldPlan {
  main: PlannedSession[];
  comeback: PlannedSession[];
  recovery: PlannedSession[];
  friends: [PlannedSession[], PlannedSession[], PlannedSession[]];
}

/** The streak needs 6 days of this month before today. */
export const EARLIEST_DAY = 8;

export class DemoTooEarlyError extends Error {
  override name = 'DemoTooEarlyError';
  constructor() {
    super(`A demo world needs the ${EARLIEST_DAY}th of the month or later.`);
  }
}

const DAY_MS = 86_400_000;
const toDay = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const fromDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => fromDay(toDay(date) + days);
/** The first day of the month `back` months before `date`'s. */
function monthStart(date: string, back: number): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - back, 1));
  return d.toISOString().slice(0, 10);
}

const at = (localDate: string, minutes: number, startHour = 8, startMinute = 30) => ({
  localDate,
  startHour,
  startMinute,
  minutes,
});

/** Every other day from the 1st, 120 minutes each, the last day taking the remainder. */
function everyOtherDay(first: string, total: number, early = 0): PlannedSession[] {
  const out: PlannedSession[] = [];
  let left = total;
  for (let i = 0; left > 0; i += 2) {
    const minutes = Math.min(120, left);
    left -= minutes;
    const isEarly = out.length < early;
    out.push(at(addDays(first, i), minutes, isEarly ? 6 : 8, isEarly ? 15 : 30));
  }
  return out;
}

export function worldPlan(today: string): WorldPlan {
  const dayOfMonth = Number(today.slice(8, 10));
  if (dayOfMonth < EARLIEST_DAY) throw new DemoTooEarlyError();
  const ago = (n: number) => addDays(today, -n);

  const streak = [120, 119, 119, 119, 119, 119].map((minutes, i) => at(ago(6 - i), minutes));
  const main = [
    ...everyOtherDay(monthStart(today, 2), 600, 3),
    ...everyOtherDay(monthStart(today, 1), 1680, 3),
    ...streak,
  ];

  const comeback = [
    ...everyOtherDay(monthStart(today, 1), 480),
    ...[10, 8, 6, 4].filter((n) => n < dayOfMonth).map((n) => at(ago(n), 60)),
  ];

  const recovery = [
    ...everyOtherDay(monthStart(today, 1), 480),
    ...[5, 4, 3, 2].map((n) => at(ago(n), 45)),
  ];

  // Each friend focuses the week before, and yesterday (in the Community Tree's window).
  const friend = (week: number, yesterday: number, hour: number) => [
    ...[6, 5, 4, 3, 2].map((n) => at(ago(n), week, hour)),
    at(ago(1), yesterday, hour),
  ];
  return {
    main,
    comeback,
    recovery,
    friends: [friend(50, 120, 9), friend(80, 100, 14), friend(30, 70, 19)],
  };
}
