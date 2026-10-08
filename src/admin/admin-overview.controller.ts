import { BadRequestException, Get, Query } from '@nestjs/common';

import { CheckpointMetricsService } from '../analytics/checkpoint-metrics.service.js';
import type { CohortMetrics, UserMetrics } from '../analytics/checkpoint-metrics.js';
import { Clock } from '../common/clock.js';
import { isLocalDate } from '../common/local-date.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { AdminController } from './admin-route.decorator.js';
import { CohortQueryDto } from './dto/admin-users.dto.js';

export interface AdminDashboard {
  /** UTC days, plain operational counts (docs/09 → Dashboard). */
  signupsLast7Days: number;
  sessionsToday: number;
  discardedToday: number;
  activeUsersLast7Days: number;
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
  async dashboard(): Promise<AdminDashboard> {
    const now = this.clock.now();
    const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const [signups, sessions, discarded, active] = await Promise.all([
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
    ]);
    return {
      signupsLast7Days: signups,
      sessionsToday: sessions,
      discardedToday: discarded,
      activeUsersLast7Days: Number(active[0]?.count ?? 0),
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
