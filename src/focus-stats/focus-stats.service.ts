import { Injectable } from '@nestjs/common';

import type { LocalDate } from '../common/local-date.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { MonthRef } from '../sessions/attribution/calendar.js';
import { sortTopics, type DayFocus, type TopicFocus } from './focus-stats.js';

type Client = Prisma.TransactionClient;

/**
 * Per-day and per-topic totals of counted sessions, aggregated by PostgreSQL from
 * focus_sessions. There are no aggregate tables: the sessions are the source. Pass a
 * transaction client to include rows written earlier in that transaction.
 */
@Injectable()
export class FocusStatsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Counted focus per stored local date, for the sessions attributed to one month. */
  async monthDays(
    userId: string,
    month: MonthRef,
    client: Client = this.prisma,
  ): Promise<DayFocus[]> {
    return this.days(client, { userId, year: month.year, month: month.month });
  }

  /** Counted focus per stored local date in [from, to], whatever month the sessions belong to. */
  async daysBetween(
    userId: string,
    from: LocalDate,
    to: LocalDate,
    client: Client = this.prisma,
  ): Promise<DayFocus[]> {
    return this.days(client, { userId, localDate: { gte: asDbDate(from), lte: asDbDate(to) } });
  }

  /** Counted focus per stored local date, over the user's whole history. */
  async allDays(userId: string, client: Client = this.prisma): Promise<DayFocus[]> {
    return this.days(client, { userId });
  }

  /** The longest counted session of each stored local date (personal records). */
  async longestSessionsByDay(
    userId: string,
    client: Client = this.prisma,
  ): Promise<{ date: LocalDate; focusedMilliseconds: number }[]> {
    const rows = await client.focusSession.groupBy({
      by: ['localDate'],
      where: { userId, status: { not: 'discarded' } },
      _max: { focusedMilliseconds: true },
      orderBy: { localDate: 'asc' },
    });
    return rows.map((row) => ({
      date: row.localDate.toISOString().slice(0, 10),
      focusedMilliseconds: row._max.focusedMilliseconds ?? 0,
    }));
  }

  /** Counted focus over the user's whole history, late sessions included (the forest header). */
  async lifetimeMilliseconds(userId: string, client: Client = this.prisma): Promise<number> {
    const total = await client.focusSession.aggregate({
      where: { userId, status: { not: 'discarded' } },
      _sum: { focusedMilliseconds: true },
    });
    return total._sum.focusedMilliseconds ?? 0;
  }

  /** Counted focus per topic for the sessions attributed to one month, largest first. */
  async monthTopics(
    userId: string,
    month: MonthRef,
    client: Client = this.prisma,
  ): Promise<TopicFocus[]> {
    const rows = await client.focusSession.groupBy({
      by: ['topicId'],
      where: { userId, year: month.year, month: month.month, status: { not: 'discarded' } },
      _sum: { focusedMilliseconds: true },
      _count: { _all: true },
    });
    return sortTopics(
      rows.map((row) => ({
        topicId: row.topicId,
        focusedMilliseconds: row._sum.focusedMilliseconds ?? 0,
        sessionCount: row._count._all,
      })),
    );
  }

  private async days(
    client: Client,
    where: {
      userId: string;
      year?: number;
      month?: number;
      localDate?: { gte: Date; lte: Date };
    },
  ): Promise<DayFocus[]> {
    const rows = await client.focusSession.groupBy({
      by: ['localDate'],
      where: { ...where, status: { not: 'discarded' } },
      _sum: { focusedMilliseconds: true },
      _count: { _all: true },
      orderBy: { localDate: 'asc' },
    });
    return rows.map((row) => ({
      date: row.localDate.toISOString().slice(0, 10),
      focusedMilliseconds: row._sum.focusedMilliseconds ?? 0,
      sessionCount: row._count._all,
    }));
  }
}

/** A DATE column value: midnight UTC of the calendar date. */
function asDbDate(date: LocalDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}
