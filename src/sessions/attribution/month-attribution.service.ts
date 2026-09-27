import { Injectable } from '@nestjs/common';

import type { MonthAttributionContext, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  attributeInContext,
  planMonthContext,
  type MonthContext,
  type SessionAttribution,
} from './month-context.js';

/**
 * Decides which month and local date a session belongs to, from its start
 * (docs/06_DOMAIN_MODEL.md → Time and attribution). The month context that contains the
 * start decides; the profile time zone is read only to create a missing context.
 */
@Injectable()
export class MonthAttributionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pass `tx` to create a missing context in the caller's transaction, for example together
   * with the session that needs it.
   */
  attribute(
    userId: string,
    startedAt: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<SessionAttribution> {
    if (tx) return this.attributeIn(tx, userId, startedAt);
    return this.prisma.$transaction((client) => this.attributeIn(client, userId, startedAt));
  }

  private async attributeIn(
    tx: Prisma.TransactionClient,
    userId: string,
    startedAt: Date,
  ): Promise<SessionAttribution> {
    const existing = await findContaining(tx, userId, startedAt);
    if (existing) return attributeInContext(existing, startedAt);

    // Creating a context reads its neighbours, so creations for one user run one at a time.
    const [user] = await tx.$queryRaw<{ timezone: string | null }[]>`
      SELECT timezone FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    if (!user) throw new Error(`User ${userId} does not exist.`);

    // Another request may have created it while this one waited for the lock.
    const created = await findContaining(tx, userId, startedAt);
    if (created) return attributeInContext(created, startedAt);

    const [previous, next] = await Promise.all([
      tx.monthAttributionContext.findFirst({
        where: { userId, endsAt: { lte: startedAt } },
        orderBy: { endsAt: 'desc' },
      }),
      tx.monthAttributionContext.findFirst({
        where: { userId, startsAt: { gt: startedAt } },
        orderBy: { startsAt: 'asc' },
      }),
    ]);

    const plan = planMonthContext({
      instant: startedAt,
      profileTimeZone: user.timezone,
      previous: previous && toContext(previous),
      next: next && toContext(next),
    });
    await tx.monthAttributionContext.create({
      data: {
        userId,
        year: plan.year,
        month: plan.month,
        timezone: plan.timeZone,
        startsAt: plan.startsAt,
        endsAt: plan.endsAt,
      },
    });
    return attributeInContext(plan, startedAt);
  }
}

async function findContaining(
  tx: Prisma.TransactionClient,
  userId: string,
  instant: Date,
): Promise<MonthContext | null> {
  const row = await tx.monthAttributionContext.findFirst({
    where: { userId, startsAt: { lte: instant }, endsAt: { gt: instant } },
  });
  return row && toContext(row);
}

function toContext(row: MonthAttributionContext): MonthContext {
  return {
    year: row.year,
    month: row.month,
    timeZone: row.timezone,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
  };
}
