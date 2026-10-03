import { Injectable } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import type { LocalDate } from '../common/local-date.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { localDateOf } from '../sessions/attribution/calendar.js';
import { unprocessable } from './http-errors.js';

/**
 * The user's current local date, in the time zone sessions are attributed with
 * (docs/06_DOMAIN_MODEL.md → Time and attribution): the current month context's when it exists,
 * otherwise the profile's. Never the server's date.
 */
@Injectable()
export class UserTodayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async today(userId: string, tx: Prisma.TransactionClient = this.prisma): Promise<LocalDate> {
    const now = this.clock.now();
    const context = await tx.monthAttributionContext.findFirst({
      where: { userId, startsAt: { lte: now }, endsAt: { gt: now } },
      select: { timezone: true },
    });
    const timeZone =
      context?.timezone ??
      (await tx.user.findUnique({ where: { id: userId }, select: { timezone: true } }))?.timezone;
    if (!timeZone) {
      throw unprocessable('timezone_required', 'Set your time zone to use goals and streaks.');
    }
    return localDateOf(now, timeZone);
  }
}
