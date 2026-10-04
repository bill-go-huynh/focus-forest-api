import { addDays, compareLocalDates, isLocalDate, weekStartOf } from '../common/local-date.js';
import type { FocusSessionStatus, Prisma } from '../generated/prisma/client.js';

/**
 * Focus History filters (spec §3.4): a local-date range (`from`/`to`, inclusive), a Monday week
 * (`week`, local dates), or an attributed month (`month`, YYYY-MM, as the monthly tree counts
 * it); plus a topic and a status. At most one of range, week, and month.
 */
export interface HistoryFilters {
  from?: string;
  to?: string;
  week?: string;
  month?: string;
  topicId?: string;
  status?: FocusSessionStatus;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The rows the filters select, or why the filters are not valid together. */
export function historyWhere(
  filters: HistoryFilters,
): { where: Prisma.FocusSessionWhereInput } | { error: string } {
  const range = filters.from !== undefined || filters.to !== undefined;
  const kinds = [range, filters.week !== undefined, filters.month !== undefined];
  if (kinds.filter(Boolean).length > 1) {
    return { error: 'Use only one of from/to, week, and month.' };
  }
  for (const [name, value] of [
    ['from', filters.from],
    ['to', filters.to],
    ['week', filters.week],
  ] as const) {
    if (value !== undefined && !isLocalDate(value)) return { error: `${name} must be YYYY-MM-DD.` };
  }
  if (filters.from && filters.to && compareLocalDates(filters.from, filters.to) > 0) {
    return { error: 'from must not be after to.' };
  }
  if (filters.week !== undefined && weekStartOf(filters.week) !== filters.week) {
    return { error: 'week must be a Monday (weeks run Monday to Sunday).' };
  }
  const month = filters.month === undefined ? null : MONTH.exec(filters.month);
  if (filters.month !== undefined && !month) return { error: 'month must be YYYY-MM.' };

  const asDate = (date: string) => new Date(`${date}T00:00:00.000Z`);
  const where: Prisma.FocusSessionWhereInput = {
    ...(filters.topicId !== undefined && { topicId: filters.topicId }),
    ...(filters.status !== undefined && { status: filters.status }),
    ...(month && { year: Number(month[1]), month: Number(month[2]) }),
  };
  if (filters.week !== undefined) {
    where.localDate = { gte: asDate(filters.week), lte: asDate(addDays(filters.week, 6)) };
  } else if (range) {
    where.localDate = {
      ...(filters.from !== undefined && { gte: asDate(filters.from) }),
      ...(filters.to !== undefined && { lte: asDate(filters.to) }),
    };
  }
  return { where };
}
