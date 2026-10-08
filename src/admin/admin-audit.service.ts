import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const PAGE_SIZE = 50;

export interface AuditPage {
  items: {
    id: string;
    admin: { id: string; email: string };
    action: string;
    targetType: string | null;
    targetId: string | null;
    reason: string | null;
    details: Record<string, string | number | boolean | null>;
    createdAt: string;
  }[];
  nextCursor: string | null;
}

const encodeCursor = (row: { createdAt: Date; id: string }) =>
  Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const createdAt = new Date(at ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'The cursor is not valid.',
      code: 'invalid_cursor',
    });
  }
  return { createdAt, id };
}

export interface AuditEntry {
  adminId: string;
  /** A stable action name, such as `user.suspend` or `session.note_reveal`. */
  action: string;
  targetType?: string;
  targetId?: string;
  reason?: string;
  details?: Record<string, string | number | boolean | null>;
}

/**
 * The admin audit log (docs/09: every destructive or user-affecting action, and every reveal of
 * personal data, records who, what, when, and why). Append-only, also in the database. Written in
 * the same transaction as the action when there is one, so an action is never left unlogged.
 */
@Injectable()
export class AdminAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Newest first; `cursor` is the previous page's `nextCursor`. */
  async list(cursor: string | null): Promise<AuditPage> {
    const after = cursor ? decodeCursor(cursor) : null;
    const rows = await this.prisma.adminAuditLog.findMany({
      where: after
        ? {
            OR: [
              { createdAt: { lt: after.createdAt } },
              { createdAt: after.createdAt, id: { lt: after.id } },
            ],
          }
        : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      include: { admin: { select: { id: true, email: true } } },
    });
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        admin: row.admin,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        reason: row.reason,
        details: row.details as AuditPage['items'][number]['details'],
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > PAGE_SIZE && last ? encodeCursor(last) : null,
    };
  }

  async record(entry: AuditEntry, tx: Prisma.TransactionClient = this.prisma): Promise<void> {
    await tx.adminAuditLog.create({
      data: {
        id: randomUUID(),
        adminId: entry.adminId,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        reason: entry.reason ?? null,
        details: entry.details ?? {},
        createdAt: this.clock.now(),
      },
    });
  }
}
