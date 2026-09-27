/**
 * Calendar arithmetic in IANA time zones, using only the runtime's Intl data.
 * Pure functions: the instant is always passed in, never read from a clock.
 */

export interface MonthRef {
  year: number;
  month: number; // 1–12
}

const HOUR_MS = 60 * 60 * 1000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The calendar date ("YYYY-MM-DD") of an instant in a time zone. */
export function localDateOf(instant: Date, timeZone: string): string {
  const parts = dateFormatter(timeZone).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

export function localMonthOf(instant: Date, timeZone: string): MonthRef {
  const [year, month] = localDateOf(instant, timeZone).split('-').map(Number);
  return { year: year ?? 0, month: month ?? 0 };
}

/**
 * The first instant whose local date is `date` ("YYYY-MM-DD"). Usually local midnight; when
 * midnight does not exist (a DST change at 00:00), the first instant that does.
 */
export function startOfLocalDate(date: string, timeZone: string): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  // Every offset is within ±14 h, so the date starts inside this window.
  let before = utcMidnight - 30 * HOUR_MS; // local date is still earlier
  let from = utcMidnight + 30 * HOUR_MS; // local date is already `date` or later
  while (from - before > 1) {
    const middle = Math.floor((before + from) / 2);
    if (localDateOf(new Date(middle), timeZone) >= date) from = middle;
    else before = middle;
  }
  return new Date(from);
}

export function monthStart(month: MonthRef, timeZone: string): Date {
  const date = `${String(month.year).padStart(4, '0')}-${String(month.month).padStart(2, '0')}-01`;
  return startOfLocalDate(date, timeZone);
}

export function addMonths(month: MonthRef, count: number): MonthRef {
  const index = monthIndex(month) + count;
  return { year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 };
}

/** Months since year 0, so months can be compared and clamped as numbers. */
export function monthIndex(month: MonthRef): number {
  return month.year * 12 + (month.month - 1);
}
