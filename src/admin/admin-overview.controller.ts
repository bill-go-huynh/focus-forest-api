import { BadRequestException, Get, Query } from '@nestjs/common';

import { CheckpointMetricsService } from '../analytics/checkpoint-metrics.service.js';
import type { CohortMetrics, UserMetrics } from '../analytics/checkpoint-metrics.js';
import { Clock } from '../common/clock.js';
import { isLocalDate } from '../common/local-date.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { AdminController, AdminRoles } from './admin-route.decorator.js';
import { CohortQueryDto } from './dto/admin-users.dto.js';

export interface AdminDashboard {
  /** UTC days, plain operational counts (docs/09 → Dashboard). */
  signupsLast7Days: number;
  sessionsToday: number;
  discardedToday: number;
  activeUsersLast7Days: number;
  /** A5.3: reports waiting for a moderator (open or in review). */
  openReports: number;
  /** Owner, 2026-10-23: the dashboard's headline numbers and its 14-day chart. */
  totalUsers: number;
  /** Counted focus, in minutes (discarded sessions add none). */
  focusMinutesToday: number;
  focusMinutesLast7Days: number;
  /** Rooms waiting or focusing now. */
  openRooms: number;
  notificationsSentToday: number;
  /** The last 14 UTC days, oldest first: sessions started and counted focus minutes. */
  days: { date: string; sessions: number; focusMinutes: number }[];
  generatedAt: string;
}

export interface AdminConfigView {
  version: number;
  values: Record<string, unknown>;
}

export interface AdminCheckpoint {
  from: string;
  to: string;
  cohort: CohortMetrics;
  users: (UserMetrics & { email: string })[];
}

const DAY = 86_400_000;

/** The dashboard, the active configuration (read only), and the checkpoint metrics. */
@AdminController('')
export class AdminOverviewController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly checkpoint: CheckpointMetricsService,
    private readonly clock: Clock,
  ) {}

  @Get('dashboard')
  @AdminRoles('admin', 'support', 'moderator', 'content')
  async dashboard(): Promise<AdminDashboard> {
    const now = this.clock.now();
    const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const [signups, sessions, discarded, active, openReports] = await Promise.all([
      this.prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      this.prisma.focusSession.count({ where: { startedAt: { gte: today } } }),
      this.prisma.focusSession.count({ where: { startedAt: { gte: today }, status: 'discarded' } }),
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT user_id) AS count FROM (
          SELECT user_id FROM analytics_events
            WHERE occurred_at >= ${weekAgo} AND name IN ('app_opened', 'app_foregrounded')
          UNION
          SELECT user_id FROM focus_sessions
            WHERE started_at >= ${weekAgo} AND status <> 'discarded'
        ) AS active`,
      this.prisma.report.count({ where: { status: { in: ['open', 'in_review'] } } }),
    ]);
    const since = new Date(today.getTime() - 13 * DAY);
    const [totalUsers, openRooms, notificationsSentToday, perDay] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.focusRoom.count({ where: { status: { in: ['lobby', 'in_session'] } } }),
      this.prisma.notificationOutbox.count({ where: { status: 'sent', sentAt: { gte: today } } }),
      this.prisma.$queryRaw<{ day: Date; sessions: bigint; focused: bigint | null }[]>`
        SELECT date_trunc('day', started_at AT TIME ZONE 'UTC') AS day,
               COUNT(*) AS sessions,
               SUM(CASE WHEN status <> 'discarded' THEN focused_milliseconds ELSE 0 END) AS focused
          FROM focus_sessions
         WHERE started_at >= ${since}
         GROUP BY 1`,
    ]);
    const byDay = new Map(
      perDay.map((row) => [
        new Date(row.day).toISOString().slice(0, 10),
        {
          sessions: Number(row.sessions),
          focusMinutes: Math.floor(Number(row.focused ?? 0) / 60_000),
        },
      ]),
    );
    const days = Array.from({ length: 14 }, (_, i) => {
      const date = new Date(since.getTime() + i * DAY).toISOString().slice(0, 10);
      const found = byDay.get(date);
      return {
        date,
        sessions: found?.sessions ?? 0,
        focusMinutes: found?.focusMinutes ?? 0,
      };
    });
    const focusMinutesToday = days.at(-1)?.focusMinutes ?? 0;
    const focusMinutesLast7Days = days
      .slice(-7)
      .reduce((total, day) => total + day.focusMinutes, 0);
    return {
      signupsLast7Days: signups,
      sessionsToday: sessions,
      discardedToday: discarded,
      activeUsersLast7Days: Number(active[0]?.count ?? 0),
      openReports,
      totalUsers,
      focusMinutesToday,
      focusMinutesLast7Days,
      openRooms,
      notificationsSentToday,
      days,
      generatedAt: now.toISOString(),
    };
  }

  @Get('config')
  async activeConfig(): Promise<AdminConfigView> {
    const active = await this.config.active();
    return { version: active.version, values: active.allValues() };
  }

  @Get('analytics/checkpoint')
  async cohort(@Query() query: CohortQueryDto): Promise<AdminCheckpoint> {
    if (!isLocalDate(query.from) || !isLocalDate(query.to) || query.from > query.to) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Choose a valid date range: from on or before to.',
        code: 'invalid_range',
      });
    }
    const report = await this.checkpoint.cohort(query.from, query.to);
    const emails = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: report.users.map((user) => user.userId) } },
          select: { id: true, email: true },
        })
      ).map((user) => [user.id, user.email]),
    );
    return {
      from: query.from,
      to: query.to,
      cohort: report.cohort,
      users: report.users.map((user) => ({ ...user, email: emails.get(user.userId) ?? '' })),
    };
  }
}
