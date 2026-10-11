import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { daysBetween, type LocalDate } from '../common/local-date.js';
import { dbDate, localDateFromDb } from '../consistency/db.js';
import { dailyGoalMinutesOn, type DailyGoalVersion } from '../consistency/goals.js';
import { unprocessable } from '../consistency/http-errors.js';
import { UserTodayService } from '../consistency/user-today.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { localDateOf } from '../sessions/attribution/calendar.js';
import { VisibilityService, type BoardCandidate } from '../social/visibility.service.js';
import { fairScore, monthPeriod, rankRows, weekPeriod, type Period } from './leaderboard-rules.js';
import type {
  LeaderboardDto,
  LeaderboardPeriodKind,
  LeaderboardRowDto,
  LeaderboardScope,
} from './leaderboards.dto.js';

/** At most this many rows; the viewer's own row is always answered on its own. */
export const LEADERBOARD_ROWS = 50;

interface Window {
  kind: LeaderboardPeriodKind;
  period: Period;
  /** Event boards count the sessions that started in the event window, as missions do. */
  startedIn: { startsAt: Date; endsAt: Date } | null;
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
    query: { scope: LeaderboardScope; period: 'weekly' | 'monthly'; eventId?: string },
  ): Promise<LeaderboardDto> {
    if (query.scope === 'event' && !query.eventId) {
      throw new BadRequestException('An event board needs an eventId.');
    }
    const event = query.scope === 'event' ? await this.boardEvent(viewerId, query.eventId!) : null;
    const window = event
      ? await this.eventWindow(viewerId, event)
      : await this.window(viewerId, query.period);
    const candidates = await this.visibility.boardCandidates(
      viewerId,
      query.scope,
      event?.id ?? null,
    );
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
      teams: event ? await this.teams(event.id, candidates, scores) : null,
    };
  }

  /** An event the viewer can see (A5.6 rule) whose board is on. */
  private async boardEvent(viewerId: string, eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: { participations: { where: { userId: viewerId } } },
    });
    const visible =
      event &&
      (event.status === 'active' ||
        (event.status === 'retired' && event.participations.length > 0));
    if (!visible || !event.leaderboard) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'This leaderboard does not exist.',
        code: 'leaderboard_not_found',
      });
    }
    return event;
  }

  private async window(viewerId: string, kind: 'weekly' | 'monthly'): Promise<Window> {
    const today = await this.userToday.today(viewerId);
    return {
      kind,
      period: kind === 'weekly' ? weekPeriod(today) : monthPeriod(today),
      startedIn: null,
    };
  }

  /** The event window's local days, in the viewer's time zone. */
  private async eventWindow(
    viewerId: string,
    event: { startsAt: Date; endsAt: Date },
  ): Promise<Window> {
    const viewer = await this.prisma.user.findUniqueOrThrow({
      where: { id: viewerId },
      select: { timezone: true },
    });
    if (!viewer.timezone) {
      throw unprocessable('timezone_required', 'Set your time zone to use goals and streaks.');
    }
    return {
      kind: 'event',
      period: {
        startDate: localDateOf(event.startsAt, viewer.timezone),
        endDate: localDateOf(new Date(event.endsAt.getTime() - 1), viewer.timezone),
      },
      startedIn: { startsAt: event.startsAt, endsAt: event.endsAt },
    };
  }

  /** Each candidate's fair score over the window. */
  private async scores(ids: string[], window: Window): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const { startDate, endDate } = window.period;
    const periodDays = daysBetween(startDate, endDate) + 1;
    const started = window.startedIn;
    const [days, goals, rests, recoveries, config] = await Promise.all([
      this.prisma.$queryRaw<{ user_id: string; local_date: Date; milliseconds: bigint }[]>`
        SELECT user_id::text, local_date, SUM(focused_milliseconds)::bigint AS milliseconds
        FROM focus_sessions
        WHERE user_id = ANY(${ids}::uuid[]) AND status <> 'discarded'
          AND local_date BETWEEN ${dbDate(startDate)}::date AND ${dbDate(endDate)}::date
          ${started ? Prisma.sql`AND started_at >= ${started.startsAt} AND started_at < ${started.endsAt}` : Prisma.empty}
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

  /**
   * Team ranking: the rounded mean score of each team's opted-in, active members, whoever is
   * viewing (a team is an aggregate that names nobody). Null when the event has no teams.
   */
  private async teams(
    eventId: string,
    candidates: readonly BoardCandidate[],
    scores: ReadonlyMap<string, number>,
  ): Promise<LeaderboardDto['teams']> {
    const teams = await this.prisma.eventTeam.findMany({
      where: { eventId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: { participations: { select: { userId: true } } },
    });
    if (teams.length === 0) return null;
    const onBoard = new Set(candidates.map((c) => c.id));
    const ranked = rankRows(
      teams.map((team) => {
        const members = team.participations.filter((p) => onBoard.has(p.userId));
        const sum = members.reduce((total, p) => total + (scores.get(p.userId) ?? 0), 0);
        return {
          id: team.id,
          name: team.name,
          members: members.length,
          score: members.length === 0 ? 0 : Math.round(sum / members.length),
        };
      }),
    );
    return ranked.map((team) => ({
      id: team.id,
      name: team.name,
      rank: team.rank,
      score: team.score,
      members: team.members,
    }));
  }
}
