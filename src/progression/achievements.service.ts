import { Injectable } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import type { LocalDate } from '../common/local-date.js';
import { localDateFromDb, lockUser } from '../consistency/db.js';
import { unprocessable } from '../consistency/http-errors.js';
import { StreakService } from '../consistency/streak.service.js';
import { isCounted } from '../focus-stats/focus-stats.js';
import { FocusStatsService } from '../focus-stats/focus-stats.service.js';
import { Prisma, type FocusSession } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  achievementValues,
  byCatalogOrder,
  earnableAchievements,
  isReached,
  parseProgressionResult,
  planGrants,
  progressOf,
  withoutRecovery,
  withoutSession,
  type AchievementInput,
  type AchievementValues,
  type EarnableAchievement,
  type PlannedGrant,
  type ProgressionResult,
} from './achievement-evaluation.js';
import {
  toBadgeDto,
  toCosmeticDto,
  toSpeciesDto,
  type SessionProgressionDto,
  type AchievementsResponse,
  type BadgesResponse,
  type EarnedBadgeDto,
} from './badge.dto.js';
import { ProgressionOwnershipService } from './progression-ownership.service.js';
import { acquirableAt, type Acquisition } from './progression-rules.js';

type Client = PrismaService | Prisma.TransactionClient;

export interface RewardGrant {
  id: string;
  /** Its achievement's badge was caused by the action being evaluated. */
  causedByAction: boolean;
}

/** What one evaluation granted: badges, and the rewards linked to owned badges. */
export interface Evaluation {
  badges: PlannedGrant[];
  species: RewardGrant[];
  cosmetics: RewardGrant[];
}

/** The authoritative action being evaluated: what it crossed is what it caused. */
type Cause =
  | { kind: 'session'; session: FocusSession }
  | { kind: 'recovery'; missedDate: LocalDate }
  | { kind: 'room'; roomId: string }
  | null;

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

  /**
   * After a Focus Together completion is stored, in the same transaction (A5.4): grants what is
   * reached and returns what this completion caused (it is not stored: the completion's answer
   * reports it once, and a repeat reports nothing).
   */
  async evaluateRoomCompletion(
    tx: Prisma.TransactionClient,
    userId: string,
    roomId: string,
  ): Promise<ProgressionResult> {
    return caused(await this.evaluate(tx, userId, { kind: 'room', roomId }));
  }

  /**
   * Grants what Core truth already earned, and the rewards of badges already owned (owners from
   * before A4.3). Idempotent; what it created, never reported as caused by an action.
   */
  reconcile(userId: string, client: Client = this.prisma): Promise<Evaluation> {
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

  /** Each criterion's current value for the user, read once (the Collection Book's hints). */
  async values(userId: string, client: Client = this.prisma): Promise<AchievementValues> {
    return achievementValues(await this.input(client, userId));
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

  /**
   * A stored progression result as the app shows it: the badges with their earned times and the
   * rewards with their unlock times, in the stored order. Null stays null (before A4.2).
   */
  async progressionView(
    userId: string,
    stored: unknown,
    client: Client = this.prisma,
  ): Promise<SessionProgressionDto | null> {
    if (stored === null) return null;
    const result = parseProgressionResult(stored);
    const species = result.newlyUnlockedSpeciesIds;
    const cosmetics = result.newlyUnlockedCosmeticIds;
    const [badges, speciesRows, cosmeticRows] = await Promise.all([
      this.earnedBadges(userId, result.newlyEarnedBadgeIds, client),
      species.length === 0
        ? []
        : client.userSpecies.findMany({
            where: { userId, speciesId: { in: species } },
            include: { species: true },
          }),
      cosmetics.length === 0
        ? []
        : client.userCosmetic.findMany({
            where: { userId, cosmeticId: { in: cosmetics } },
            include: { cosmetic: true },
          }),
    ]);
    const speciesById = new Map(speciesRows.map((row) => [row.speciesId, row]));
    const cosmeticsById = new Map(cosmeticRows.map((row) => [row.cosmeticId, row]));
    return {
      newlyEarnedBadges: badges,
      newlyUnlockedSpecies: species.flatMap((id) => {
        const row = speciesById.get(id);
        return row
          ? [{ ...toSpeciesDto(row.species), unlockedAt: row.unlockedAt.toISOString() }]
          : [];
      }),
      newlyUnlockedCosmetics: cosmetics.flatMap((id) => {
        const row = cosmeticsById.get(id);
        return row
          ? [{ ...toCosmeticDto(row.cosmetic), unlockedAt: row.unlockedAt.toISOString() }]
          : [];
      }),
    };
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

  /**
   * One evaluation: grants the badges reached, then the rewards (species, cosmetics) linked to
   * every owned badge's achievement and not yet owned (A4.3), all in the caller's transaction.
   * A reward is caused by the action exactly when its badge is.
   */
  private async evaluate(client: Client, userId: string, cause: Cause): Promise<Evaluation> {
    const now = this.clock.now();
    const definitions = await this.definitions(client);
    const badges = await this.grantReachedBadges(client, userId, cause, definitions, now);
    const causedBadges = new Set(badges.filter((g) => g.causedByAction).map((g) => g.badgeId));
    const badgeOf = new Map(definitions.map((a) => [a.id, a.badgeId]));
    const isCaused = (achievementId: string | null) =>
      achievementId !== null && causedBadges.has(badgeOf.get(achievementId) ?? '');
    const [species, cosmetics] = await Promise.all([
      client.treeSpecies.findMany({
        where: {
          achievement: { badge: { owners: { some: { userId } } } },
          owners: { none: { userId } },
        },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
      client.cosmeticDefinition.findMany({
        where: {
          achievement: { badge: { owners: { some: { userId } } } },
          owners: { none: { userId } },
        },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const grant = async (
      kind: 'species' | 'cosmetic',
      rewards: readonly (Acquisition & { id: string; achievementId: string | null })[],
    ): Promise<RewardGrant[]> => {
      // Availability decides acquisition: a reward no longer acquirable is not granted now.
      const acquirable = rewards.filter((reward) => acquirableAt(reward, now).acquirable);
      const created = new Set(
        await this.ownership.grantRewards(
          kind,
          userId,
          acquirable.map((reward) => reward.id),
          now,
          client,
        ),
      );
      return acquirable
        .filter((reward) => created.has(reward.id))
        .map((reward) => ({ id: reward.id, causedByAction: isCaused(reward.achievementId) }));
    };
    return {
      badges,
      species: await grant('species', species),
      cosmetics: await grant('cosmetic', cosmetics),
    };
  }

  private async grantReachedBadges(
    client: Client,
    userId: string,
    cause: Cause,
    definitions: Awaited<ReturnType<AchievementsService['definitions']>>,
    now: Date,
  ): Promise<PlannedGrant[]> {
    const earnable = earnableAchievements(definitions, now);
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
    if (cause.kind === 'room') {
      return achievementValues({
        ...input,
        together: await this.together(client, userId, cause.roomId),
      });
    }
    const { session } = cause;
    // A discarded session changed nothing.
    if (!isCounted(session.status)) return achievementValues(input);
    // One statement: the counted sessions of its day and its time of day.
    const [row] = await client.$queryRaw<{ same_day: bigint; hour: number }[]>`
      SELECT
        (SELECT COUNT(*) FROM focus_sessions o
          WHERE o.user_id = s.user_id AND o.local_date = s.local_date AND o.status <> 'discarded')
          AS same_day,
        EXTRACT(HOUR FROM (s.started_at AT TIME ZONE 'UTC') AT TIME ZONE c.timezone)::int AS hour
      FROM focus_sessions s
      JOIN month_attribution_contexts c
        ON c.user_id = s.user_id AND c.year = s.year AND c.month = s.month
      WHERE s.user_id = ${userId}::uuid AND s.id = ${session.id}::uuid`;
    return achievementValues(
      withoutSession(input, {
        focusedMilliseconds: session.focusedMilliseconds,
        localDate: localDateFromDb(session.localDate),
        countedOnSameDay: Number(row?.same_day ?? 1),
        startedBefore7: row !== undefined && row.hour < 7,
        startedAfter22: row !== undefined && row.hour >= 22,
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

  /**
   * Every criterion's source, read once: lifetime counted focus, the streak, and one statement for
   * Focus Together and the time of day of counted sessions.
   */
  private async input(client: Client, userId: string): Promise<AchievementInput> {
    return {
      lifetime: await this.stats.lifetime(userId, client),
      history: await this.streak.history(userId, client),
      ...(await this.sessionSources(client, userId)),
    };
  }

  /**
   * - Focus Together (A5.4): see `together`.
   * - Time of day (2026-10-15): counted sessions started before 07:00 and at or after 22:00, in
   *   the local time of their month's time zone (docs/06 Time and attribution). started_at is
   *   stored as UTC without a zone: read as UTC, then in the month's zone.
   */
  private async sessionSources(
    client: Client,
    userId: string,
  ): Promise<Pick<AchievementInput, 'together' | 'timeOfDay'>> {
    const [row] = await client.$queryRaw<
      {
        sessions: bigint;
        with_friend: bigint;
        early: bigint;
        late: bigint;
      }[]
    >`
      WITH together AS (${this.togetherQuery(userId, null)}),
      local_hours AS (
        SELECT EXTRACT(HOUR FROM (s.started_at AT TIME ZONE 'UTC') AT TIME ZONE c.timezone) AS hour
        FROM focus_sessions s
        JOIN month_attribution_contexts c
          ON c.user_id = s.user_id AND c.year = s.year AND c.month = s.month
        WHERE s.user_id = ${userId}::uuid AND s.status <> 'discarded'
      )
      SELECT together.sessions, together.with_friend,
        (SELECT COUNT(*) FROM local_hours WHERE hour < 7) AS early,
        (SELECT COUNT(*) FROM local_hours WHERE hour >= 22) AS late
      FROM together`;
    return {
      together: { sessions: Number(row?.sessions ?? 0), withFriend: Number(row?.with_friend ?? 0) },
      timeOfDay: { early: Number(row?.early ?? 0), late: Number(row?.late ?? 0) },
    };
  }

  /**
   * A5.4, derived from room places (no counters): the user's completed Focus Together sessions,
   * and those in a room where someone who started with them is a friend (a mutual follow) now.
   * `excludedRoomId` leaves one room out: the values just before its completion.
   */
  private async together(
    client: Client,
    userId: string,
    excludedRoomId: string | null = null,
  ): Promise<AchievementInput['together']> {
    const [row] = await client.$queryRaw<{ sessions: bigint; with_friend: bigint }[]>`
      ${this.togetherQuery(userId, excludedRoomId)}`;
    return { sessions: Number(row?.sessions ?? 0), withFriend: Number(row?.with_friend ?? 0) };
  }

  private togetherQuery(userId: string, excludedRoomId: string | null): Prisma.Sql {
    return Prisma.sql`
      SELECT COUNT(*) AS sessions,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM room_participants other
          WHERE other.room_id = mine.room_id AND other.user_id <> mine.user_id AND other.in_session
            AND EXISTS (SELECT 1 FROM follows WHERE follower_id = mine.user_id AND followee_id = other.user_id)
            AND EXISTS (SELECT 1 FROM follows WHERE follower_id = other.user_id AND followee_id = mine.user_id)
        )) AS with_friend
      FROM room_participants mine
      WHERE mine.user_id = ${userId}::uuid AND mine.session_id IS NOT NULL
        AND (${excludedRoomId}::uuid IS NULL OR mine.room_id <> ${excludedRoomId}::uuid)`;
  }
}

function caused(evaluation: Evaluation): ProgressionResult {
  return {
    newlyEarnedBadgeIds: evaluation.badges.filter((g) => g.causedByAction).map((g) => g.badgeId),
    newlyUnlockedSpeciesIds: evaluation.species.filter((g) => g.causedByAction).map((g) => g.id),
    newlyUnlockedCosmeticIds: evaluation.cosmetics.filter((g) => g.causedByAction).map((g) => g.id),
  };
}
