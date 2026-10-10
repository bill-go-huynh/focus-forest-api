import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { AdminAuditService } from '../admin/admin-audit.service.js';
import { Clock } from '../common/clock.js';
import type { ModerationAction, Prisma, ReportStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  ReportDetail,
  ReportPerson,
  ReportQueueItem,
  ResolveReportDto,
} from './dto/moderation.dto.js';

const PAGE = 50;
const UNFINISHED: ReportStatus[] = ['open', 'in_review'];
type Tx = Prisma.TransactionClient;

const PERSON = { id: true, email: true, username: true, displayName: true } as const;
const WITH_PEOPLE = {
  reporter: { select: PERSON },
  target: { select: { ...PERSON, status: true, bio: true, avatarUrl: true } },
  reviewedBy: { select: { email: true } },
  resolvedBy: { select: { email: true } },
} as const;
type ReportRow = Prisma.ReportGetPayload<{ include: typeof WITH_PEOPLE }>;

/** The audit action for what a resolution did to the reported user. */
const USER_ACTION: Record<Exclude<ModerationAction, 'none'>, string> = {
  warn: 'user.warn',
  reset_username: 'user.reset_username',
  reset_bio: 'user.reset_bio',
  reset_avatar: 'user.reset_avatar',
  suspend: 'user.suspend',
  ban: 'user.ban',
};

/**
 * A5.3, the moderators' side (docs/09 Reports and moderation): the queue, one report with its
 * context, and the decisions. A report moves open → in review → resolved or dismissed, once:
 * each decision locks the report (and the reported user) and is audited in the same transaction,
 * so two moderators never decide the same report twice.
 */
@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly clock: Clock,
  ) {}

  /** Oldest first: the queue is worked in the order reports arrived. */
  async queue(
    status: ReportStatus | undefined,
    cursor: string | undefined,
  ): Promise<{ items: ReportQueueItem[]; nextCursor: string | null }> {
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const rows = await this.prisma.report.findMany({
      where: {
        status: status ? status : { in: UNFINISHED },
        ...(after && {
          OR: [{ createdAt: { gt: after.at } }, { createdAt: after.at, id: { gt: after.id } }],
        }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PAGE + 1,
      include: WITH_PEOPLE,
    });
    const page = rows.slice(0, PAGE);
    const open = await this.openCounts(page.map((row) => row.targetId));
    const last = page.at(-1);
    return {
      items: page.map((row) => toItem(row, open.get(row.targetId) ?? 0)),
      nextCursor: rows.length > PAGE && last ? encodeCursor(last) : null,
    };
  }

  async detail(reportId: string, client: Tx | PrismaService = this.prisma): Promise<ReportDetail> {
    const row = await client.report.findUnique({ where: { id: reportId }, include: WITH_PEOPLE });
    if (!row) throw reportNotFound();
    const [open, reports, warnings, reporterBlocksTarget, targetBlocksReporter] = await Promise.all(
      [
        this.openCounts([row.targetId], client),
        client.report.count({ where: { targetId: row.targetId } }),
        client.userWarning.count({ where: { userId: row.targetId } }),
        row.reporterId
          ? client.block.count({ where: { blockerId: row.reporterId, blockedId: row.targetId } })
          : 0,
        row.reporterId
          ? client.block.count({ where: { blockerId: row.targetId, blockedId: row.reporterId } })
          : 0,
      ],
    );
    return {
      ...toItem(row, open.get(row.targetId) ?? 0),
      targetProfile: {
        username: row.target.username,
        displayName: row.target.displayName,
        bio: row.target.bio,
        avatarUrl: row.target.avatarUrl,
      },
      blocks: {
        reporterBlocksTarget: reporterBlocksTarget > 0,
        targetBlocksReporter: targetBlocksReporter > 0,
      },
      targetHistory: { reports, warnings, status: row.target.status },
      reviewedBy: row.reviewedBy?.email ?? null,
      resolution:
        row.resolvedAt && row.resolutionReason !== null
          ? {
              action: row.action,
              reason: row.resolutionReason,
              resolvedBy: row.resolvedBy?.email ?? null,
              resolvedAt: row.resolvedAt.toISOString(),
            }
          : null,
    };
  }

  async review(adminId: string, reportId: string): Promise<ReportDetail> {
    return this.prisma.$transaction(async (tx) => {
      const report = await lockReport(tx, reportId);
      if (report.status !== 'open') {
        throw conflict('report_not_open', 'This report is already being reviewed or is closed.');
      }
      await tx.report.update({
        where: { id: reportId },
        data: { status: 'in_review', reviewedById: adminId, reviewedAt: this.clock.now() },
      });
      await this.audit.record(
        { adminId, action: 'report.review', targetType: 'report', targetId: reportId },
        tx,
      );
      return this.detail(reportId, tx);
    });
  }

  async resolve(adminId: string, reportId: string, input: ResolveReportDto): Promise<ReportDetail> {
    if (input.action === 'warn' && !input.message) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'A warning needs a message for the user.',
        code: 'warning_message_required',
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const report = await lockReport(tx, reportId);
      if (!UNFINISHED.includes(report.status)) throw reportClosed();
      const now = this.clock.now();
      await this.apply(tx, report, input, now);
      await tx.report.update({
        where: { id: reportId },
        data: {
          status: 'resolved',
          action: input.action,
          resolutionReason: input.reason,
          resolvedById: adminId,
          resolvedAt: now,
        },
      });
      await this.audit.record(
        {
          adminId,
          action: 'report.resolve',
          targetType: 'report',
          targetId: reportId,
          reason: input.reason,
          details: { action: input.action, userId: report.targetId },
        },
        tx,
      );
      if (input.action !== 'none') {
        await this.audit.record(
          {
            adminId,
            action: USER_ACTION[input.action],
            targetType: 'user',
            targetId: report.targetId,
            reason: input.reason,
            details: { reportId },
          },
          tx,
        );
      }
      return this.detail(reportId, tx);
    });
  }

  async dismiss(adminId: string, reportId: string, reason: string): Promise<ReportDetail> {
    return this.prisma.$transaction(async (tx) => {
      const report = await lockReport(tx, reportId);
      if (!UNFINISHED.includes(report.status)) throw reportClosed();
      await tx.report.update({
        where: { id: reportId },
        data: {
          status: 'dismissed',
          resolutionReason: reason,
          resolvedById: adminId,
          resolvedAt: this.clock.now(),
        },
      });
      await this.audit.record(
        { adminId, action: 'report.dismiss', targetType: 'report', targetId: reportId, reason },
        tx,
      );
      return this.detail(reportId, tx);
    });
  }

  /** What the resolution does to the reported user, under their row lock. */
  private async apply(
    tx: Tx,
    report: { id: string; targetId: string },
    input: ResolveReportDto,
    now: Date,
  ): Promise<void> {
    const userId = report.targetId;
    const [user] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    if (!user) throw reportNotFound();
    switch (input.action) {
      case 'none':
        return;
      case 'warn':
        await tx.userWarning.create({
          data: { userId, reportId: report.id, message: input.message!, createdAt: now },
        });
        return;
      case 'reset_username':
        await tx.user.update({ where: { id: userId }, data: { username: null } });
        return;
      case 'reset_bio':
        await tx.user.update({ where: { id: userId }, data: { bio: null } });
        return;
      case 'reset_avatar':
        await tx.user.update({ where: { id: userId }, data: { avatarUrl: null } });
        return;
      case 'suspend':
      case 'ban': {
        if (input.action === 'suspend' && user.status !== 'active') {
          throw conflict('already_suspended', 'This account is already suspended or banned.');
        }
        if (input.action === 'ban' && user.status === 'banned') {
          throw conflict('already_banned', 'This account is already banned.');
        }
        await tx.user.update({
          where: { id: userId },
          data: { status: input.action === 'suspend' ? 'suspended' : 'banned' },
        });
        // Every sign-in ends at once: no refresh token keeps working.
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: now },
        });
        return;
      }
    }
  }

  private async openCounts(
    userIds: string[],
    client: Tx | PrismaService = this.prisma,
  ): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const rows = await client.report.groupBy({
      by: ['targetId'],
      where: { targetId: { in: [...new Set(userIds)] }, status: { in: UNFINISHED } },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.targetId, row._count._all]));
  }
}

async function lockReport(
  tx: Tx,
  reportId: string,
): Promise<{ status: ReportStatus; targetId: string; id: string }> {
  const [row] = await tx.$queryRaw<{ id: string; status: ReportStatus; target_id: string }[]>`
    SELECT id, status::text AS status, target_id FROM reports WHERE id = ${reportId}::uuid FOR UPDATE`;
  if (!row) throw reportNotFound();
  return { id: row.id, status: row.status, targetId: row.target_id };
}

function person(user: {
  id: string;
  email: string;
  username: string | null;
  displayName: string | null;
}): ReportPerson {
  return { id: user.id, email: user.email, username: user.username, displayName: user.displayName };
}

function toItem(row: ReportRow, openReports: number): ReportQueueItem {
  return {
    id: row.id,
    category: row.category,
    status: row.status,
    details: row.details,
    createdAt: row.createdAt.toISOString(),
    reporter: row.reporter ? person(row.reporter) : null,
    target: { ...person(row.target), status: row.target.status, openReports },
  };
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const date = new Date(at ?? '');
  if (!id || !/^[0-9a-f-]{36}$/.test(id) || Number.isNaN(date.getTime())) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'The cursor is not valid.',
      code: 'invalid_cursor',
    });
  }
  return { at: date, id };
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, error: 'Conflict', message, code });
}

function reportClosed(): ConflictException {
  return conflict('report_closed', 'This report is already resolved or dismissed.');
}

function reportNotFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    message: 'This report does not exist.',
    code: 'report_not_found',
  });
}
