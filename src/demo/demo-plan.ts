/**
 * DM.1 The demo world's histories (spec/demo/PLAN.md), as local dates and times in the
 * presenter's time zone. Pure: the service turns them into sessions.
 *
 * - Main presenter: an August tree of 600 minutes (archived when the world is made), a September
 *   tree of 2,395 (left to close on the first app open: the planting ceremony and recap) that
 *   opens with a 7-day run (the 7-Day Streak, which owns Pine), and nothing this month: its tree
 *   is a Seed whose species can still be chosen (owner, 2026-10-23). 2,995 in all, so one
 *   5-minute session, the shortest that counts, passes 50 hours (3,000) and owns Maple.
 * - Comeback presenter: nothing for the last 3 days (Resting quietly; a session wakes it).
 * - Recovery presenter: 4 days in a row, then yesterday missed (a session today opens the offer).
 * - Friends: Mai and Khoa focus the week before; Linh (the second phone) has two full months
 *   and most days this month (owner, 2026-10-23).
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

/** Every other day from `first`, `chunk` minutes each, the last day taking the remainder. */
function everyOtherDay(first: string, total: number, early = 0, chunk = 120): PlannedSession[] {
  const out: PlannedSession[] = [];
  let left = total;
  for (let i = 0; left > 0; i += 2) {
    const minutes = Math.min(chunk, left);
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

  // Last month opens with 7 days in a row (120 each), then every other day from the 9th.
  const lastMonth = monthStart(today, 1);
  const run = Array.from({ length: 7 }, (_, i) => at(addDays(lastMonth, i), 120, i < 3 ? 6 : 8));
  const main = [
    ...everyOtherDay(monthStart(today, 2), 600, 3),
    ...run,
    ...everyOtherDay(addDays(lastMonth, 8), 2395 - 7 * 120, 0, 180),
  ];

  const comeback = [
    ...everyOtherDay(monthStart(today, 1), 480),
    ...[10, 8, 6, 4].filter((n) => n < dayOfMonth).map((n) => at(ago(n), 60)),
  ];

  const recovery = [
    ...everyOtherDay(monthStart(today, 1), 480),
    ...[5, 4, 3, 2].map((n) => at(ago(n), 45)),
  ];

  // Each friend focuses the week before, and yesterday.
  const friend = (week: number, yesterday: number, hour: number) => [
    ...[6, 5, 4, 3, 2].map((n) => at(ago(n), week, hour)),
    at(ago(1), yesterday, hour),
  ];
  // Linh is the second phone in the demo (owner, 2026-10-23): two full months in her forest and
  // most days this month, at varied hours and lengths, so her Insights and forest look lived in.
  const lengths = [45, 60, 90, 30, 120];
  const hours = [7, 9, 14, 20, 16];
  const thisMonth = Array.from({ length: dayOfMonth - 1 }, (_, i) => dayOfMonth - 1 - i)
    .filter((n) => n % 4 !== 0)
    .map((n) => at(ago(n), lengths[n % 5]!, hours[n % 5]));
  const linh = [
    ...everyOtherDay(monthStart(today, 2), 1260, 0, 150),
    ...everyOtherDay(monthStart(today, 1), 1950, 0, 150),
    ...thisMonth,
  ];
  return {
    main,
    comeback,
    recovery,
    friends: [friend(50, 120, 9), friend(80, 100, 14), linh],
  };
}
