import { Injectable } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import type { LocalDate } from '../common/local-date.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { localDateOf } from '../sessions/attribution/calendar.js';
import {
  cohortMetrics,
  userMetrics,
  type CohortMetrics,
  type MonthRef,
  type UserMetrics,
} from './checkpoint-metrics.js';

/** The events that mean "the app was opened that day". */
const OPEN_EVENTS = ['app_opened', 'app_foregrounded'];

export interface CheckpointReport {
  cohort: CohortMetrics;
  users: UserMetrics[];
}

/**
 * Core Loop Checkpoint metrics (CR.2), derived on every read from analytics events, counted
 * sessions, and archived trees, never stored. A fixed set of batched reads whatever the number
 * of users or days. Read only by the admin (CR.4).
 */
@Injectable()
export class CheckpointMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Users who joined on UTC dates `from` to `to` (inclusive), and their cohort. */
  async cohort(from: LocalDate, to: LocalDate): Promise<CheckpointReport> {
    const users = await this.prisma.user.findMany({
      where: {
        createdAt: { gte: utcMidnight(from), lt: new Date(utcMidnight(to).getTime() + 86_400_000) },
      },
      select: { id: true, createdAt: true, timezone: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const metrics = await this.metricsOf(users);
    return { cohort: cohortMetrics(metrics), users: metrics };
  }

  /** One user's metrics, or null for an unknown user. */
  async forUser(userId: string): Promise<UserMetrics | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, createdAt: true, timezone: true },
    });
    return user ? ((await this.metricsOf([user]))[0] ?? null) : null;
  }

  private async metricsOf(
    users: { id: string; createdAt: Date; timezone: string | null }[],
  ): Promise<UserMetrics[]> {
    if (users.length === 0) return [];
    const ids = users.map((user) => user.id);
    const [opens, focus, archives] = await Promise.all([
      this.prisma.analyticsEvent.groupBy({
        by: ['userId', 'localDate'],
        where: { userId: { in: ids }, name: { in: OPEN_EVENTS } },
      }),
      this.prisma.focusSession.groupBy({
        by: ['userId', 'localDate'],
        where: { userId: { in: ids }, status: { not: 'discarded' } },
      }),
      this.prisma.monthlyTree.findMany({
        where: { userId: { in: ids }, status: 'archived' },
        select: { userId: true, year: true, month: true },
        orderBy: [{ year: 'asc' }, { month: 'asc' }],
      }),
    ]);
    const datesBy = (rows: { userId: string; localDate: Date }[]) => {
      const map = new Map<string, LocalDate[]>();
      for (const row of rows) {
        const list = map.get(row.userId) ?? [];
        list.push(row.localDate.toISOString().slice(0, 10));
        map.set(row.userId, list);
      }
      return map;
    };
    const openDates = datesBy(opens);
    const focusDates = datesBy(focus);
    const firstArchive = new Map<string, MonthRef>();
    for (const tree of archives) {
      if (!firstArchive.has(tree.userId)) {
        firstArchive.set(tree.userId, { year: tree.year, month: tree.month });
      }
    }
    const now = this.clock.now();
    return users.map((user) => {
      const timeZone = user.timezone ?? 'UTC';
      return userMetrics({
        userId: user.id,
        joinedOn: localDateOf(user.createdAt, timeZone),
        today: localDateOf(now, timeZone),
        openDates: openDates.get(user.id) ?? [],
        focusDates: focusDates.get(user.id) ?? [],
        firstArchive: firstArchive.get(user.id) ?? null,
      });
    });
  }
}

const utcMidnight = (date: LocalDate) => new Date(`${date}T00:00:00.000Z`);
