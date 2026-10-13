import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ContentNotAcquirableError,
  ContentNotFoundError,
  type ContentKind,
  ProgressionOwnershipService,
} from '../progression/progression-ownership.service.js';
import { AdminAuditService } from './admin-audit.service.js';

const KINDS: readonly ContentKind[] = ['badge', 'cosmetic', 'species'];
const RECENT = 50;

export interface NotificationDiagnostics {
  devices: {
    token: string;
    platform: string;
    appVersion: string | null;
    registeredAt: string;
    lastSeenAt: string;
  }[];
  focusUntil: string | null;
  enabled: { category: string; time: string | null }[];
  recent: {
    category: string;
    title: string;
    status: string;
    reason: string | null;
    notBefore: string;
    sentAt: string | null;
  }[];
}

/**
 * Support operations (A6.6, docs/09): compensation grants after incidents (admins only, always
 * logged), and why a person's notifications were or were not sent.
 */
@Injectable()
export class AdminSupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: ProgressionOwnershipService,
    private readonly audit: AdminAuditService,
    private readonly clock: Clock,
  ) {}

  async grant(
    adminId: string,
    userId: string,
    body: Record<string, unknown>,
  ): Promise<{ kind: ContentKind; itemId: string; grantedAt: string }> {
    const kind = KINDS.find((k) => k === body['kind']);
    const itemId = typeof body['itemId'] === 'string' ? body['itemId'] : '';
    const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
    const problems: string[] = [];
    if (!kind) problems.push(`kind must be one of: ${KINDS.join(', ')}.`);
    if (!itemId) problems.push('itemId must name an item.');
    if (reason.length < 3 || reason.length > 500)
      problems.push('reason must say why, in 3 to 500 characters.');
    if (problems.length > 0) throw unprocessable('invalid_grant', problems);

    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.user.findUnique({ where: { id: userId } }))) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          message: 'This user does not exist.',
          code: 'user_not_found',
        });
      }
      let grant;
      try {
        grant = await this.ownership.compensate(kind!, userId, itemId, this.clock.now(), tx);
      } catch (error) {
        if (error instanceof ContentNotFoundError) {
          throw new NotFoundException({
            statusCode: 404,
            error: 'Not Found',
            message: `There is no ${kind} ${itemId}.`,
            code: 'content_not_found',
          });
        }
        if (error instanceof ContentNotAcquirableError) {
          throw unprocessable('not_grantable', [
            error.reason === 'not_active'
              ? `The ${kind} ${itemId} is not out yet.`
              : `Everyone owns the ${kind} ${itemId} already.`,
          ]);
        }
        throw error;
      }
      if (!grant.granted) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: `This person owns the ${kind} ${itemId} already.`,
          code: 'already_owned',
        });
      }
      await this.audit.record(
        {
          adminId,
          action: 'user.grant',
          targetType: 'user',
          targetId: userId,
          reason,
          details: { kind: kind!, itemId },
        },
        tx,
      );
      return { kind: kind!, itemId, grantedAt: grant.at.toISOString() };
    });
  }

  async notifications(userId: string): Promise<NotificationDiagnostics> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        pushDevices: { orderBy: { registeredAt: 'asc' } },
        focusLease: true,
        notificationPreferences: { where: { enabled: true }, orderBy: { category: 'asc' } },
      },
    });
    if (!user) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'This user does not exist.',
        code: 'user_not_found',
      });
    }
    const recent = await this.prisma.notificationOutbox.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      take: RECENT,
    });
    return {
      devices: user.pushDevices.map((device) => ({
        token: masked(device.token),
        platform: device.platform,
        appVersion: device.appVersion,
        registeredAt: device.registeredAt.toISOString(),
        lastSeenAt: device.lastSeenAt.toISOString(),
      })),
      focusUntil: user.focusLease?.endsAt.toISOString() ?? null,
      enabled: user.notificationPreferences.map((p) => ({ category: p.category, time: p.time })),
      recent: recent.map((row) => ({
        category: row.category,
        title: row.title,
        status: row.status,
        reason: row.reason,
        notBefore: row.notBefore.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
      })),
    };
  }
}

/** A push token shows its first and last three characters: enough to match, not to send. */
function masked(token: string): string {
  const open = token.indexOf('[');
  const inner = token.slice(open + 1, -1);
  if (open < 0 || inner.length <= 6) return token;
  return `${token.slice(0, open + 1)}${inner.slice(0, 3)}…${inner.slice(-3)}]`;
}

function unprocessable(code: string, problems: string[]): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message: problems.join(' '),
    code,
    problems,
  });
}
