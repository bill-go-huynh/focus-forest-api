import { Injectable } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { daysBetween, type LocalDate } from '../common/local-date.js';
import { dbDate, localDateFromDb } from '../consistency/db.js';
import { dailyGoalMinutesOn, type DailyGoalVersion } from '../consistency/goals.js';
import { UserTodayService } from '../consistency/user-today.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { localDateOf } from '../sessions/attribution/calendar.js';
import { VisibilityService } from '../social/visibility.service.js';
import { fairScore, monthPeriod, rankRows, weekPeriod, type Period } from './leaderboard-rules.js';
import type {
  LeaderboardDto,
  LeaderboardPeriodKind,
  LeaderboardRowDto,
  LeaderboardScope,
} from './leaderboards.dto.js';

/** A board as staff see it (A6.5): rows without `you`, and no viewer's own row. */
export interface StaffBoardDto {
  scope: 'global';
  period: LeaderboardDto['period'];
  rows: Omit<LeaderboardRowDto, 'you'>[];
}

/** At most this many rows; the viewer's own row is always answered on its own. */
export const LEADERBOARD_ROWS = 50;

interface Window {
  kind: LeaderboardPeriodKind;
  period: Period;
}

/**
 * A5.8 Leaderboards (spec §16, docs/02 Leaderboards, docs/06 Leaderboard). Derived on read from
 * counted sessions, goals, rest days, and recoveries: one query each for every candidate, then
 * scored in memory. No cache and no job (docs/08 §6: only when load measurably requires them).
 * Who may appear comes from the visibility gate: opted in, active, and not blocked either way.
 */
@Injectable()
export class LeaderboardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly visibility: VisibilityService,
    private readonly userToday: UserTodayService,
    private readonly clock: Clock,
  ) {}

  async board(
    viewerId: string,
    query: { scope: LeaderboardScope; period: 'weekly' | 'monthly' },
  ): Promise<LeaderboardDto> {
    const window = await this.window(viewerId, query.period);
    const candidates = await this.visibility.boardCandidates(viewerId, query.scope);
    const scores = await this.scores(
      candidates.map((c) => c.id),
      window,
    );

    const ranked = rankRows(
      candidates
        .filter((c) => !c.blocked)
        .map((c) => ({
          ...c,
          name: c.displayName ?? c.username ?? '',
          score: scores.get(c.id) ?? 0,
        }))
        .filter((c) => c.score > 0),
    );
    const rows = ranked.map((row): LeaderboardRowDto => ({
      rank: row.rank,
      person: {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
      },
      score: row.score,
      you: row.id === viewerId,
    }));
    const optedIn =
      (await this.prisma.privacySettings.count({
        where: { userId: viewerId, leaderboards: true },
      })) > 0;

    return {
      scope: query.scope,
      period: { kind: window.kind, ...window.period },
      optedIn,
      rows: rows.slice(0, LEADERBOARD_ROWS),
      you: rows.find((row) => row.you) ?? null,
    };
  }

  /**
   * A6.5: the global board as staff see it (docs/09: view leaderboards). There is no viewer:
   * nobody is hidden by a block, and local dates are UTC dates.
   */
  async staffBoard(query: {
    scope: 'global';
    period: 'weekly' | 'monthly';
  }): Promise<StaffBoardDto> {
    const today = localDateOf(this.clock.now(), 'UTC');
    const window: Window = {
      kind: query.period,
      period: query.period === 'weekly' ? weekPeriod(today) : monthPeriod(today),
    };
    const candidates = await this.visibility.boardCandidates(null, query.scope);
    const scores = await this.scores(
      candidates.map((c) => c.id),
      window,
    );
    const ranked = rankRows(
      candidates
        .map((c) => ({
          ...c,
          name: c.displayName ?? c.username ?? '',
          score: scores.get(c.id) ?? 0,
        }))
        .filter((c) => c.score > 0),
    );
    return {
      scope: query.scope,
      period: { kind: window.kind, ...window.period },
      rows: ranked.slice(0, LEADERBOARD_ROWS).map((row) => ({
        rank: row.rank,
        person: {
          id: row.id,
          username: row.username,
          displayName: row.displayName,
          avatarUrl: row.avatarUrl,
        },
        score: row.score,
      })),
    };
  }

  private async window(viewerId: string, kind: 'weekly' | 'monthly'): Promise<Window> {
    const today = await this.userToday.today(viewerId);
    return {
      kind,
      period: kind === 'weekly' ? weekPeriod(today) : monthPeriod(today),
    };
  }

  /** Each candidate's fair score over the window. */
  private async scores(ids: string[], window: Window): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const { startDate, endDate } = window.period;
    const periodDays = daysBetween(startDate, endDate) + 1;
    const [days, goals, rests, recoveries, config] = await Promise.all([
      this.prisma.$queryRaw<{ user_id: string; local_date: Date; milliseconds: bigint }[]>`
        SELECT user_id::text, local_date, SUM(focused_milliseconds)::bigint AS milliseconds
        FROM focus_sessions
        WHERE user_id = ANY(${ids}::uuid[]) AND status <> 'discarded'
          AND local_date BETWEEN ${dbDate(startDate)}::date AND ${dbDate(endDate)}::date
        GROUP BY user_id, local_date`,
      this.prisma.dailyGoalSetting.findMany({
        where: { userId: { in: ids } },
        orderBy: { effectiveFrom: 'asc' },
      }),
      this.prisma.restDay.findMany({
        where: { userId: { in: ids }, date: { gte: dbDate(startDate), lte: dbDate(endDate) } },
      }),
      this.prisma.streakRecovery.findMany({
        where: {
          userId: { in: ids },
          missedDate: { gte: dbDate(startDate), lte: dbDate(endDate) },
        },
      }),
      this.config.active(),
    ]);
    const weights = config.get('leaderboard.scoreWeights');
    const cap = config.get('leaderboard.dailyFocusCapMinutes');

    const scores = new Map<string, number>();
    for (const id of ids) {
      const own = days
        .filter((row) => row.user_id === id)
        .map((row) => ({
          date: localDateFromDb(row.local_date),
          minutes: Number(row.milliseconds) / 60_000,
        }));
      const versions: DailyGoalVersion[] = goals
        .filter((row) => row.userId === id)
        .map((row) => ({
          effectiveFrom: localDateFromDb(row.effectiveFrom),
          minutes: row.minutes,
        }));
      const kept = new Set<LocalDate>([
        ...own.map((day) => day.date),
        ...rests.filter((row) => row.userId === id).map((row) => localDateFromDb(row.date)),
        ...recoveries
          .filter((row) => row.userId === id)
          .map((row) => localDateFromDb(row.missedDate)),
      ]);
      scores.set(
        id,
        fairScore(
          {
            periodDays,
            keptDays: kept.size,
            goalMetDays: own.filter((day) => {
              const goal = dailyGoalMinutesOn(versions, day.date);
              return goal !== null && day.minutes >= goal;
            }).length,
            dailyMinutes: own.map((day) => day.minutes),
          },
          weights,
          cap,
        ),
      );
    }
    return scores;
  }
}
