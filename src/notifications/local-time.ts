import { addDays } from '../common/local-date.js';
import { localDateOf } from '../sessions/attribution/calendar.js';

/**
 * Local wall-clock times in IANA time zones (reminders at the person's time, the day window).
 * Pure functions on the runtime's Intl data, like `sessions/attribution/calendar.ts`.
 */

const MIN = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The local wall-clock time of an instant, as if it were UTC (milliseconds). */
function wallTime(instant: Date, timeZone: string): number {
  const parts = wallFormatter(timeZone).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  return Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
}

/** Minutes since local midnight. */
export function localMinutesOf(instant: Date, timeZone: string): number {
  const wall = wallTime(instant, timeZone);
  return Math.floor((wall % 86_400_000) / MIN);
}

/**
 * The instant at local `date` ("YYYY-MM-DD") and `minutes` past midnight. A time skipped by a
 * daylight-saving change gives the first instant after the gap.
 */
export function instantAt(date: string, minutes: number, timeZone: string): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const wanted = Date.UTC(year, month - 1, day) + minutes * MIN;
  const offsetAt = (instant: number) => wallTime(new Date(instant), timeZone) - instant;

  const first = wanted - offsetAt(wanted);
  const second = wanted - offsetAt(first);
  for (const candidate of [first, second]) {
    if (wallTime(new Date(candidate), timeZone) === wanted) return new Date(candidate);
  }
  // In a gap: the earliest instant whose wall time is at or after the wanted one.
  let before = Math.min(first, second);
  let after = Math.max(first, second);
  while (after - before > MIN) {
    const middle = before + Math.floor((after - before) / 2 / MIN) * MIN;
    if (wallTime(new Date(middle), timeZone) >= wanted) after = middle;
    else before = middle;
  }
  return new Date(after);
}

/** "HH:MM" (a validated reminder time) as minutes past midnight. */
export function minutesOfReminderTime(time: string): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** The local date of `instant`, and the next one. */
export function localDayAfter(instant: Date, timeZone: string): string {
  return addDays(localDateOf(instant, timeZone), 1);
}
