/**
 * Calendar dates without a time or time zone ("YYYY-MM-DD"), such as a session's stored local
 * date. Arithmetic runs on day numbers in UTC, so a date never shifts with the process time zone.
 *
 * Weeks run Monday to Sunday everywhere in the product (Phase 3 decision): weekly goals, the
 * rest-day allowance, weekly insights, and records all use weekStartOf.
 */

export type LocalDate = string;

interface CalendarMonth {
  year: number;
  month: number; // 1–12
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLocalDate(value: string): boolean {
  const match = FORMAT.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth({ year, month });
}

/** Days since 1970-01-01. */
function dayNumber(date: LocalDate): number {
  if (!isLocalDate(date)) throw new Error(`"${date}" is not a calendar date (YYYY-MM-DD).`);
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function fromDayNumber(days: number): LocalDate {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return fromDayNumber(dayNumber(date) + days);
}

/** Days from `from` to `to`: positive when `to` is later. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return dayNumber(to) - dayNumber(from);
}

export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return dayNumber(a) - dayNumber(b);
}

/** The Monday of the week (Monday to Sunday) that contains `date`. */
export function weekStartOf(date: LocalDate): LocalDate {
  const days = dayNumber(date);
  // 1970-01-01 was a Thursday, so (days + 3) mod 7 is 0 on Mondays.
  const sinceMonday = (((days + 3) % 7) + 7) % 7;
  return fromDayNumber(days - sinceMonday);
}

export function daysInMonth({ year, month }: CalendarMonth): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function firstDateOfMonth({ year, month }: CalendarMonth): LocalDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
}

export function lastDateOfMonth(month: CalendarMonth): LocalDate {
  return addDays(firstDateOfMonth(month), daysInMonth(month) - 1);
}
