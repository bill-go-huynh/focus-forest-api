import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { CheckpointMetricsService } from '../analytics/checkpoint-metrics.service.js';
import type { UserMetrics } from '../analytics/checkpoint-metrics.js';
import { Clock } from '../common/clock.js';
import { summarizeStreak } from '../consistency/streak.js';
import { StreakService } from '../consistency/streak.service.js';
import { FocusStatsService } from '../focus-stats/focus-stats.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { localDateOf } from '../sessions/attribution/calendar.js';
import { AdminAuditService } from './admin-audit.service.js';
import { explainSession, type SessionExplanation } from './session-diagnostics.js';

const USERS_PAGE = 25;
const SESSIONS_PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string | null;
  /** A5.3. */
  username: string | null;
  status: 'active' | 'suspended' | 'banned';
  joinedAt: string;
  timezone: string | null;
}

export interface AdminUserDetail {
  profile: AdminUserRow & { bio: string | null };
  lifetime: {
    focusedMilliseconds: number;
    sessionCount: number;
    archivedTreeCount: number;
    /** Null without a time zone (no "today" to count from). */
    currentStreak: number | null;
    longestStreak: number | null;
  };
  /** The latest growing tree, as stored: numbers and a stage label (docs/09). */
  currentTree: {
    year: number;
    month: number;
    stage: string;
    species: string;
    fullnessLevel: number;
    blossomLevel: number;
    richnessTier: number;
  } | null;
  rewards: { badges: number; species: number; cosmetics: number };
  shareUsageData: boolean;
  checkpoint: UserMetrics;
  /** A5.3 (docs/09: reports involving the user, block relationships). Counts only. */
  moderation: {
    reportsAbout: number;
    openReportsAbout: number;
    reportsFiled: number;
    warnings: number;
    /** Users this user blocks. */
    blocking: number;
    /** Users who block this user. */
    blockedBy: number;
  };
}

export interface AdminSessionRow {
  id: string;
  startedAt: string;
  status: 'completed' | 'ended_early' | 'discarded';
  plannedMinutes: number;
  focusedMilliseconds: number;
  pausedMilliseconds: number;
  configVersion: number;
  topic: { id: string; name: string };
  /** Notes are personal: hidden unless revealed with a reason (docs/09). */
  hasNote: boolean;
  explanation: SessionExplanation;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * The early admin's user support (CR.4; docs/09): look users up, read their stats, tree, sessions
 * with why each counted, and act on an account. Reads never change product state (no month
 * closure, no tree creation). Every user-affecting action and every note reveal is audited in
 * the same transaction.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly stats: FocusStatsService,
    private readonly streak: StreakService,
    private readonly config: ProductConfigService,
    private readonly checkpoint: CheckpointMetricsService,
    private readonly clock: Clock,
  ) {}

  async search(query: string | undefined, cursor: string | undefined): Promise<Page<AdminUserRow>> {
    const after = cursor ? decodeCursor(cursor) : null;
    const q = query?.trim() ?? '';
    const match: Prisma.UserWhereInput = !q
      ? {}
      : UUID.test(q)
        ? { id: q.toLowerCase() }
        : {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { displayName: { contains: q, mode: 'insensitive' } },
              { username: { contains: q, mode: 'insensitive' } },
            ],
          };
    const rows = await this.prisma.user.findMany({
      where: after
        ? {
            AND: [
              match,
              {
                OR: [
                  { createdAt: { lt: after.at } },
                  { createdAt: after.at, id: { lt: after.id } },
                ],
              },
            ],
          }
        : match,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: USERS_PAGE + 1,
      select: USER_ROW,
    });
    return page(rows, USERS_PAGE, toRow, (row) => ({ at: row.createdAt, id: row.id }));
  }

  async detail(userId: string): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ...USER_ROW, bio: true, preferences: { select: { shareUsageData: true } } },
    });
    if (!user) throw notFound();
    const [lifetime, archivedTreeCount, tree, badges, species, cosmetics, history, checkpoint] =
      await Promise.all([
        this.stats.lifetime(userId),
        this.prisma.monthlyTree.count({ where: { userId, status: 'archived' } }),
        this.prisma.monthlyTree.findFirst({
          where: { userId, status: 'growing' },
          orderBy: [{ year: 'desc' }, { month: 'desc' }],
          select: {
            year: true,
            month: true,
            stage: true,
            species: true,
            fullnessLevel: true,
            blossomLevel: true,
            richnessTier: true,
          },
        }),
        this.prisma.userBadge.count({ where: { userId } }),
        this.prisma.userSpecies.count({ where: { userId } }),
        this.prisma.userCosmetic.count({ where: { userId } }),
        this.streak.history(userId),
        this.checkpoint.forUser(userId),
      ]);
    const moderation = await this.moderationCounts(userId);
    const streak = user.timezone
      ? summarizeStreak(history, localDateOf(this.clock.now(), user.timezone))
      : null;
    return {
      profile: { ...toRow(user), bio: user.bio },
      lifetime: {
        ...lifetime,
        archivedTreeCount,
        currentStreak: streak?.current ?? null,
        longestStreak: streak?.longest ?? null,
      },
      currentTree: tree,
      rewards: { badges, species, cosmetics },
      shareUsageData: user.preferences?.shareUsageData ?? true,
      checkpoint: checkpoint!,
      moderation,
    };
  }

  private async moderationCounts(userId: string): Promise<AdminUserDetail['moderation']> {
    const [reportsAbout, openReportsAbout, reportsFiled, warnings, blocking, blockedBy] =
      await Promise.all([
        this.prisma.report.count({ where: { targetId: userId } }),
        this.prisma.report.count({
          where: { targetId: userId, status: { in: ['open', 'in_review'] } },
        }),
        this.prisma.report.count({ where: { reporterId: userId } }),
        this.prisma.userWarning.count({ where: { userId } }),
        this.prisma.block.count({ where: { blockerId: userId } }),
        this.prisma.block.count({ where: { blockedId: userId } }),
      ]);
    return { reportsAbout, openReportsAbout, reportsFiled, warnings, blocking, blockedBy };
  }

  async sessions(userId: string, cursor: string | undefined): Promise<Page<AdminSessionRow>> {
    await this.requireUser(userId);
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await this.prisma.focusSession.findMany({
      where: {
        userId,
        ...(after
          ? {
              OR: [{ startedAt: { lt: after.at } }, { startedAt: after.at, id: { lt: after.id } }],
            }
          : {}),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: SESSIONS_PAGE + 1,
      select: {
        id: true,
        startedAt: true,
        status: true,
        plannedMinutes: true,
        focusedMilliseconds: true,
        pausedMilliseconds: true,
        submittedEndedAt: true,
        effectiveEndedAt: true,
        configVersion: true,
        note: true,
        topic: { select: { id: true, name: true } },
      },
    });
    const rules = new Map<
      number,
      { version: number; minValidMinutes: number; maxPauseMinutes: number }
    >();
    for (const version of new Set(rows.map((row) => row.configVersion))) {
      const config = await this.config.version(version);
      rules.set(version, {
        version,
        minValidMinutes: config.get('session.minValidMinutes'),
        maxPauseMinutes: config.get('session.maxPauseMinutes'),
      });
    }
    return page(
      rows,
      SESSIONS_PAGE,
      (row) => ({
        id: row.id,
        startedAt: row.startedAt.toISOString(),
        status: row.status,
        plannedMinutes: row.plannedMinutes,
        focusedMilliseconds: row.focusedMilliseconds,
        pausedMilliseconds: row.pausedMilliseconds,
        configVersion: row.configVersion,
        topic: row.topic,
        hasNote: row.note !== null,
        explanation: explainSession(row, rules.get(row.configVersion)!),
      }),
      (row) => ({ at: row.startedAt, id: row.id }),
    );
  }

  /** A session's note, for a support case: audited with its reason before it is answered. */
  async revealNote(
    adminId: string,
    userId: string,
    sessionId: string,
    reason: string,
  ): Promise<{ note: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.focusSession.findFirst({
        where: { id: sessionId, userId },
        select: { note: true },
      });
      if (!session) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          message: 'This session does not exist for this user.',
          code: 'session_not_found',
        });
      }
      await this.audit.record(
        {
          adminId,
          action: 'session.note_reveal',
          targetType: 'session',
          targetId: sessionId,
          reason,
          details: { userId },
        },
        tx,
      );
      return { note: session.note };
    });
  }

  /** Suspends an account: it can no longer sign in, refresh, or use a token it still holds. */
  async suspend(adminId: string, userId: string, reason: string): Promise<AdminUserRow> {
    return this.setStatus(adminId, userId, reason, 'suspended');
  }

  async reactivate(adminId: string, userId: string, reason: string): Promise<AdminUserRow> {
    return this.setStatus(adminId, userId, reason, 'active');
  }

  /**
   * Deletes an account and everything it owns, on the user's request. The email must be typed
   * again. The audit entry keeps the id and a hash of the email, never the email itself.
   */
  async delete(
    adminId: string,
    userId: string,
    reason: string,
    confirmEmail: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (!user) throw notFound();
      if (user.email !== confirmEmail) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: 'The email does not match this account.',
          code: 'confirm_email_mismatch',
        });
      }
      await this.audit.record(
        {
          adminId,
          action: 'user.delete',
          targetType: 'user',
          targetId: userId,
          reason,
          details: { emailSha256: createHash('sha256').update(user.email).digest('hex') },
        },
        tx,
      );
      await tx.user.delete({ where: { id: userId } });
    });
  }

  private async setStatus(
    adminId: string,
    userId: string,
    reason: string,
    status: 'active' | 'suspended',
  ): Promise<AdminUserRow> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } });
      if (!user) throw notFound();
      // Suspending needs an active account; reactivating lifts a suspension or a ban (A5.3).
      if (status === 'suspended' ? user.status !== 'active' : user.status === 'active') {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message:
            status === 'suspended'
              ? 'This account is already suspended.'
              : 'This account is not suspended.',
          code: status === 'suspended' ? 'already_suspended' : 'not_suspended',
        });
      }
      const updated = await tx.user.update({
        where: { id: userId },
        data: { status },
        select: USER_ROW,
      });
      if (status === 'suspended') {
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: this.clock.now() },
        });
      }
      await this.audit.record(
        {
          adminId,
          action: status === 'suspended' ? 'user.suspend' : 'user.reactivate',
          targetType: 'user',
          targetId: userId,
          reason,
        },
        tx,
      );
      return toRow(updated);
    });
  }

  private async requireUser(userId: string): Promise<void> {
    if (!(await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) {
      throw notFound();
    }
  }
}

const USER_ROW = {
  id: true,
  email: true,
  displayName: true,
  username: true,
  status: true,
  createdAt: true,
  timezone: true,
} as const;

function toRow(user: {
  id: string;
  email: string;
  displayName: string | null;
  username: string | null;
  status: 'active' | 'suspended' | 'banned';
  createdAt: Date;
  timezone: string | null;
}): AdminUserRow {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    username: user.username,
    status: user.status,
    joinedAt: user.createdAt.toISOString(),
    timezone: user.timezone,
  };
}

function page<R, T>(
  rows: R[],
  size: number,
  map: (row: R) => T,
  key: (row: R) => { at: Date; id: string },
): Page<T> {
  const items = rows.slice(0, size);
  const last = items.at(-1);
  return {
    items: items.map(map),
    nextCursor:
      rows.length > size && last
        ? Buffer.from(`${key(last).at.toISOString()}|${key(last).id}`).toString('base64url')
        : null,
  };
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const date = new Date(at ?? '');
  if (!id || Number.isNaN(date.getTime())) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'The cursor is not valid.',
      code: 'invalid_cursor',
    });
  }
  return { at: date, id };
}

function notFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    message: 'This user does not exist.',
    code: 'user_not_found',
  });
}
