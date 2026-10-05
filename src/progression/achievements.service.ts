import { Injectable } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import type { LocalDate } from '../common/local-date.js';
import { localDateFromDb, lockUser } from '../consistency/db.js';
import { unprocessable } from '../consistency/http-errors.js';
import { StreakService } from '../consistency/streak.service.js';
import { isCounted } from '../focus-stats/focus-stats.js';
import { FocusStatsService } from '../focus-stats/focus-stats.service.js';
import type { FocusSession, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  achievementValues,
  byCatalogOrder,
  earnableAchievements,
  isReached,
  planGrants,
  progressOf,
  withoutRecovery,
  withoutSession,
  type AchievementInput,
  type EarnableAchievement,
  type PlannedGrant,
  type ProgressionResult,
} from './achievement-evaluation.js';
import {
  toBadgeDto,
  type AchievementsResponse,
  type BadgesResponse,
  type EarnedBadgeDto,
} from './badge.dto.js';
import { ProgressionOwnershipService } from './progression-ownership.service.js';

type Client = PrismaService | Prisma.TransactionClient;

/** The authoritative action being evaluated: what it crossed is what it caused. */
type Cause =
  { kind: 'session'; session: FocusSession } | { kind: 'recovery'; missedDate: LocalDate } | null;

/**
 * Achievements and badges (A4.2; docs/06_DOMAIN_MODEL.md → Achievement, Badge). One evaluator:
 * it loads the earnable definitions, reads each criterion's value once from Core truth, and
 * grants every reached badge not yet owned in one statement (the ownership key decides under
 * concurrency). It runs in the session submission transaction, after the tree, under the user's
 * row lock; and lazily (reconciliation) when achievements or badges are read, so history from
 * before A4.2 is granted without a backfill. It never writes Core data.
 */
@Injectable()
export class AchievementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: ProgressionOwnershipService,
    private readonly stats: FocusStatsService,
    private readonly streak: StreakService,
    private readonly clock: Clock,
  ) {}

  /**
   * After a session is stored and its tree updated, in the same transaction: grants what is
   * reached and returns the badges this session caused, to store with it.
   */
  async evaluateSession(
    tx: Prisma.TransactionClient,
    userId: string,
    session: FocusSession,
  ): Promise<ProgressionResult> {
    return caused(await this.evaluate(tx, userId, { kind: 'session', session }));
  }

  /**
   * After a streak recovery is stored, in the same transaction (A4.2.G): a recovered day can
   * raise the longest streak across a threshold. Grants what is reached and returns the badges
   * this recovery caused, to store with it.
   */
  async evaluateRecovery(
    tx: Prisma.TransactionClient,
    userId: string,
    missedDate: LocalDate,
  ): Promise<ProgressionResult> {
    return caused(await this.evaluate(tx, userId, { kind: 'recovery', missedDate }));
  }

  /** Grants what Core truth already earned. Idempotent; the grants it created. */
  reconcile(userId: string, client: Client = this.prisma): Promise<PlannedGrant[]> {
    return this.evaluate(client, userId, null);
  }

  /**
   * Earnable achievements and those already owned, in catalog order, with progress. Planned,
   * future-phase, and retired-but-unowned achievements are not listed.
   */
  async achievements(userId: string): Promise<AchievementsResponse> {
    await this.reconcile(userId);
    const now = this.clock.now();
    const [definitions, owned] = await Promise.all([
      this.definitions(this.prisma),
      this.ownedTimes(this.prisma, userId),
    ]);
    const earnable = new Set(earnableAchievements(definitions, now).map((a) => a.id));
    const listed = definitions
      .filter((a) => owned.has(a.badgeId) || earnable.has(a.id))
      .sort(byCatalogOrder);
    const values = achievementValues(await this.input(this.prisma, userId));
    return {
      items: listed.map((achievement) => ({
        id: achievement.id,
        badge: toBadgeDto(achievement.badge),
        ...progressOf(
          achievement,
          values[achievement.criterion],
          owned.get(achievement.badgeId) ?? null,
        ),
        progressVisible: achievement.progressVisible,
      })),
    };
  }

  /** Owned badges in earned order, and the showcase in the user's order. */
  async badges(userId: string): Promise<BadgesResponse> {
    await this.reconcile(userId);
    const rows = await this.prisma.userBadge.findMany({
      where: { userId },
      include: { badge: true, showcase: true },
      orderBy: [{ earnedAt: 'asc' }, { badgeId: 'asc' }],
    });
    const earned = (row: (typeof rows)[number]): EarnedBadgeDto => ({
      ...toBadgeDto(row.badge),
      earnedAt: row.earnedAt.toISOString(),
    });
    return {
      items: rows.map(earned),
      showcase: rows
        .filter((row) => row.showcase !== null)
        .sort((a, b) => (a.showcase?.position ?? 0) - (b.showcase?.position ?? 0))
        .map(earned),
    };
  }

  /**
   * Replaces the showcase with these owned badges, in this order (at most three, no repeats:
   * checked by the request). Atomic, under the user's row lock; the same body is idempotent.
   */
  async setShowcase(userId: string, badgeIds: readonly string[]): Promise<BadgesResponse> {
    await this.reconcile(userId);
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const owned = await tx.userBadge.count({ where: { userId, badgeId: { in: [...badgeIds] } } });
      if (owned !== new Set(badgeIds).size || owned !== badgeIds.length) {
        throw unprocessable('badge_not_owned', 'Only badges you have earned can be pinned.');
      }
      await tx.badgeShowcase.deleteMany({ where: { userId } });
      await tx.badgeShowcase.createMany({
        data: badgeIds.map((badgeId, index) => ({ userId, badgeId, position: index + 1 })),
      });
    });
    return this.badges(userId);
  }

  /** Owned badges by id, in the given order, as the app shows them (a session's result). */
  async earnedBadges(
    userId: string,
    badgeIds: readonly string[],
    client: Client = this.prisma,
  ): Promise<EarnedBadgeDto[]> {
    if (badgeIds.length === 0) return [];
    const rows = await client.userBadge.findMany({
      where: { userId, badgeId: { in: [...badgeIds] } },
      include: { badge: true },
    });
    const byId = new Map(rows.map((row) => [row.badgeId, row]));
    return badgeIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [{ ...toBadgeDto(row.badge), earnedAt: row.earnedAt.toISOString() }] : [];
    });
  }

  private async evaluate(client: Client, userId: string, cause: Cause): Promise<PlannedGrant[]> {
    const now = this.clock.now();
    const earnable = earnableAchievements(await this.definitions(client), now);
    if (earnable.length === 0) return [];
    const owned = await client.userBadge.findMany({
      where: { userId, badgeId: { in: earnable.map((a) => a.badgeId) } },
      select: { badgeId: true },
    });
    const ownedIds = new Set(owned.map((row) => row.badgeId));
    const pending = earnable.filter((a) => !ownedIds.has(a.badgeId));
    if (pending.length === 0) return [];

    const input = await this.input(client, userId);
    const after = achievementValues(input);
    const reached = pending.filter((a) => isReached(after[a.criterion], a.target));
    if (reached.length === 0) return [];

    const before = cause ? await this.valuesBefore(client, userId, input, cause) : null;
    const backlog = reached.filter(
      (a) => before === null || isReached(before[a.criterion], a.target),
    );
    const plan = planGrants(
      reached,
      { after, before },
      now,
      await this.crossings(
        client,
        userId,
        backlog,
        cause?.kind === 'session' ? cause.session.id : null,
      ),
    );
    const created = new Set(
      (await this.ownership.grantBadges(userId, plan, now, client)).map((grant) => grant.badgeId),
    );
    return plan.filter((grant) => created.has(grant.badgeId));
  }

  /** The values just before the action: what it crossed is what it caused. */
  private async valuesBefore(
    client: Client,
    userId: string,
    input: AchievementInput,
    cause: NonNullable<Cause>,
  ) {
    if (cause.kind === 'recovery')
      return achievementValues(withoutRecovery(input, cause.missedDate));
    const { session } = cause;
    // A discarded session changed nothing.
    if (!isCounted(session.status)) return achievementValues(input);
    const countedOnSameDay = await client.focusSession.count({
      where: { userId, localDate: session.localDate, status: { not: 'discarded' } },
    });
    return achievementValues(
      withoutSession(input, {
        focusedMilliseconds: session.focusedMilliseconds,
        localDate: localDateFromDb(session.localDate),
        countedOnSameDay,
      }),
    );
  }

  /**
   * For session totals reached before the session being evaluated (or before A4.2): when the
   * server stored the counted session that crossed each threshold, in one statement. The
   * sessions are ordered as the server received them (created_at), the evaluated one left out.
   */
  private async crossings(
    client: Client,
    userId: string,
    achievements: readonly EarnableAchievement[],
    excludedSessionId: string | null,
  ): Promise<Map<string, Date>> {
    const totals = achievements.filter(
      (a) => a.criterion === 'counted_sessions' || a.criterion === 'focused_minutes',
    );
    if (totals.length === 0) return new Map();
    const rows = await client.$queryRaw<{ id: string; crossed_at: Date | null }[]>`
      WITH counted AS (
        SELECT created_at,
          COUNT(*) OVER w AS sessions,
          SUM(focused_milliseconds) OVER w AS milliseconds
        FROM focus_sessions
        WHERE user_id = ${userId}::uuid
          AND status <> 'discarded'
          AND (${excludedSessionId}::uuid IS NULL OR id <> ${excludedSessionId}::uuid)
        WINDOW w AS (ORDER BY created_at, id ROWS UNBOUNDED PRECEDING)
      )
      SELECT a.id, (
        SELECT MIN(counted.created_at) FROM counted
        WHERE CASE a.criterion
          WHEN 'counted_sessions' THEN counted.sessions >= a.target
          ELSE counted.milliseconds >= a.target::bigint * 60000
        END
      ) AS crossed_at
      FROM unnest(
        ${totals.map((a) => a.id)}::text[],
        ${totals.map((a) => a.criterion)}::text[],
        ${totals.map((a) => a.target)}::int[]
      ) AS a(id, criterion, target)`;
    return new Map(
      rows.flatMap((row) => (row.crossed_at ? [[row.id, row.crossed_at] as const] : [])),
    );
  }

  private definitions(client: Client) {
    return client.achievementDefinition.findMany({ include: { badge: true } });
  }

  private async ownedTimes(client: Client, userId: string): Promise<Map<string, Date>> {
    const rows = await client.userBadge.findMany({ where: { userId } });
    return new Map(rows.map((row) => [row.badgeId, row.earnedAt]));
  }

  /** Every criterion's source, read once: lifetime counted focus and the streak history. */
  private async input(client: Client, userId: string): Promise<AchievementInput> {
    return {
      lifetime: await this.stats.lifetime(userId, client),
      history: await this.streak.history(userId, client),
    };
  }
}

function caused(grants: readonly PlannedGrant[]): ProgressionResult {
  return {
    newlyEarnedBadgeIds: grants
      .filter((grant) => grant.causedByAction)
      .map((grant) => grant.badgeId),
  };
}
