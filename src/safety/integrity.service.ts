import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AdminAuditService } from '../admin/admin-audit.service.js';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { integrityFlags, type IntegrityFlag } from './integrity-rules.js';

const DAY = 86_400_000;

export interface IntegrityItem {
  user: { id: string; email: string; username: string | null; displayName: string | null };
  flags: IntegrityFlag[];
}

/**
 * A7.3 Leaderboard integrity (owner decision 8: flags for staff; staff decide). Flags are
 * computed on read from the counted sessions of people on the boards (opted in, not excluded),
 * over `integrity.lookbackDays`; dismissed flags are left out. Nothing here changes a score or a
 * board: staff exclude an account with A6.5, or dismiss a flag with a reason.
 */
@Injectable()
export class IntegrityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly audit: AdminAuditService,
    private readonly clock: Clock,
  ) {}

  async flags(): Promise<{ items: IntegrityItem[] }> {
    const active = await this.config.active();
    const rules = {
      maxDailyFocusMinutes: active.get('integrity.maxDailyFocusMinutes'),
      lateSubmissionHours: active.get('integrity.lateSubmissionHours'),
      spike: active.get('integrity.spike'),
    };
    // Four more weeks give the earliest week its usual weeks to compare with.
    const since = new Date(
      this.clock.now().getTime() - (active.get('integrity.lookbackDays') + 28) * DAY,
    );
    const shownFrom = new Date(
      this.clock.now().getTime() - active.get('integrity.lookbackDays') * DAY,
    );
    const people = await this.prisma.user.findMany({
      where: {
        status: 'active',
        username: { not: null },
        privacySettings: { leaderboards: true },
        leaderboardExclusion: null,
        focusSessions: { some: { status: { not: 'discarded' }, startedAt: { gte: shownFrom } } },
      },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        integrityDismissals: { select: { flagKey: true } },
        focusSessions: {
          where: { status: { not: 'discarded' }, startedAt: { gte: since } },
          select: {
            id: true,
            localDate: true,
            startedAt: true,
            effectiveEndedAt: true,
            focusedMilliseconds: true,
            createdAt: true,
          },
        },
      },
    });

    const items: IntegrityItem[] = [];
    for (const person of people) {
      const dismissed = new Set(person.integrityDismissals.map((d) => d.flagKey));
      const started = new Map(person.focusSessions.map((s) => [s.id, s.startedAt.getTime()]));
      const flags = integrityFlags(
        person.focusSessions.map((s) => ({
          id: s.id,
          localDate: s.localDate.toISOString().slice(0, 10),
          startedAt: s.startedAt,
          endedAt: s.effectiveEndedAt,
          focusedMilliseconds: s.focusedMilliseconds,
          submittedAt: s.createdAt,
        })),
        rules,
      ).filter(
        (flag) => !dismissed.has(flag.key) && evidenceAt(flag, started) >= shownFrom.getTime(),
      );
      if (flags.length > 0) {
        items.push({
          user: {
            id: person.id,
            email: person.email,
            username: person.username,
            displayName: person.displayName,
          },
          flags,
        });
      }
    }
    items.sort(
      (a, b) =>
        b.flags.length - a.flags.length ||
        (a.user.username ?? '').localeCompare(b.user.username ?? ''),
    );
    return { items };
  }

  async dismiss(adminId: string, userId: string, key: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (!(await tx.user.findUnique({ where: { id: userId }, select: { id: true } }))) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          message: 'This user does not exist.',
          code: 'user_not_found',
        });
      }
      if (
        await tx.integrityDismissal.findUnique({
          where: { userId_flagKey: { userId, flagKey: key } },
        })
      ) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: 'This flag was already dismissed.',
          code: 'already_dismissed',
        });
      }
      await tx.integrityDismissal.create({
        data: { userId, flagKey: key, adminId, reason: reason.trim(), createdAt: this.clock.now() },
      });
      await this.audit.record(
        {
          adminId,
          action: 'integrity.dismiss',
          targetType: 'user',
          targetId: userId,
          reason: reason.trim(),
          details: { key },
        },
        tx,
      );
    });
  }
}

/**
 * When a flag's evidence ends, for the lookback: the end of its day or week, or the start of its
 * (later) session. Older sessions are read only as the weeks a spike compares with.
 */
function evidenceAt(flag: IntegrityFlag, started: ReadonlyMap<string, number>): number {
  if (flag.kind === 'day_total') return Date.parse(`${flag.detail.localDate}T00:00:00Z`) + DAY - 1;
  if (flag.kind === 'spike') return Date.parse(`${flag.detail.weekStart}T00:00:00Z`) + 7 * DAY - 1;
  if (flag.kind === 'late') return started.get(flag.detail.sessionId) ?? 0;
  return started.get(flag.detail.sessionIds[1]) ?? 0;
}
