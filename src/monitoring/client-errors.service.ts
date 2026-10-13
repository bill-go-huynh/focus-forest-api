import { Injectable, type OnModuleInit } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { JobsService } from '../jobs/jobs.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ClientErrorDto } from './dto/client-errors.dto.js';
import { redact } from './monitoring-rules.js';

const DAY = 86_400_000;
/** How long reports are kept. */
export const RETENTION_DAYS = 30;
export const PRUNE_JOB = 'clientErrors.prune';
const MESSAGE_MAX = 500;
const STACK_MAX = 4000;

export interface ClientErrorGroup {
  kind: string;
  message: string;
  platform: string;
  appVersion: string;
  screen: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** The latest report's stack. */
  stack: string | null;
}

/**
 * A7.4 Crash and error reports from the apps (owner decision 1: self-built, no third party).
 * Stored without anyone's identity, text cut and emails removed; kept 30 days; read by staff
 * grouped by what went wrong, on which version and screen.
 */
@Injectable()
export class ClientErrorsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.jobs.registerRecurring(PRUNE_JOB, DAY, (slot) => this.prune(slot));
  }

  async record(errors: readonly ClientErrorDto[]): Promise<{ accepted: number }> {
    const receivedAt = this.clock.now();
    const { count } = await this.prisma.clientError.createMany({
      data: errors.map((error) => ({
        receivedAt,
        occurredAt: new Date(error.occurredAt),
        kind: error.kind,
        platform: error.platform,
        appVersion: error.appVersion,
        screen: error.screen ?? null,
        message: redact(error.message, MESSAGE_MAX),
        stack: error.stack ? redact(error.stack, STACK_MAX) : null,
      })),
    });
    return { accepted: count };
  }

  /** The last `days`, grouped, the most recent group first. */
  async groups(days: number): Promise<{ items: ClientErrorGroup[] }> {
    const since = new Date(this.clock.now().getTime() - days * DAY);
    const rows = await this.prisma.clientError.findMany({
      where: { receivedAt: { gte: since } },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });
    const groups = new Map<string, ClientErrorGroup>();
    for (const row of rows) {
      const key = JSON.stringify([row.kind, row.message, row.platform, row.appVersion, row.screen]);
      const at = row.receivedAt.toISOString();
      const group = groups.get(key);
      if (group) {
        group.count += 1;
        group.lastSeen = at;
        group.stack = row.stack;
      } else {
        groups.set(key, {
          kind: row.kind,
          message: row.message,
          platform: row.platform,
          appVersion: row.appVersion,
          screen: row.screen,
          count: 1,
          firstSeen: at,
          lastSeen: at,
          stack: row.stack,
        });
      }
    }
    return {
      items: [...groups.values()].sort(
        (a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.count - a.count,
      ),
    };
  }

  /** Removes reports received more than `RETENTION_DAYS` before `slot`. */
  async prune(slot: Date): Promise<number> {
    const { count } = await this.prisma.clientError.deleteMany({
      where: { receivedAt: { lt: new Date(slot.getTime() - RETENTION_DAYS * DAY) } },
    });
    return count;
  }
}
