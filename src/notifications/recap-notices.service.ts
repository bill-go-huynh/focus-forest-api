import { Injectable, type OnModuleInit } from '@nestjs/common';

import { JobsService } from '../jobs/jobs.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addMonths, localDateOf } from '../sessions/attribution/calendar.js';
import { instantAt } from './local-time.js';
import { notificationLinks } from './notification-links.js';
import { NotificationsService } from './notifications.service.js';

/**
 * "Your recap is ready" (A6.3, spec §18 Monthly recap ready). On the first of each local month,
 * when the day window opens, to those who turned it on and had counted focus in the month that
 * just ended. The recap itself is still made when it is first opened (docs/08 lazy closure).
 */

export const RECAP_NOTICES_JOB = 'recaps.notices';
const SLOT_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

@Injectable()
export class RecapNoticesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerRecurring(RECAP_NOTICES_JOB, SLOT_MS, (slot) => this.plan(slot));
  }

  /** Enqueues the recap notices whose moment falls in the quarter hour starting at `slot`. */
  async plan(slot: Date): Promise<number> {
    const end = slot.getTime() + SLOT_MS;
    const opens = (await this.notifications.limits()).informationalHours.start * 60;
    const people = await this.prisma.notificationPreference.findMany({
      where: {
        category: 'monthlyRecapReady',
        enabled: true,
        user: { status: 'active', timezone: { not: null } },
      },
      select: { userId: true, user: { select: { timezone: true } } },
    });

    let planned = 0;
    for (const { userId, user } of people) {
      const timeZone = user.timezone!;
      const date = localDateOf(slot, timeZone);
      if (!date.endsWith('-01')) continue;
      const at = instantAt(date, opens, timeZone);
      if (at.getTime() < slot.getTime() || at.getTime() >= end) continue;
      const [year = 0, month = 1] = date.split('-').map(Number);
      const ended = addMonths({ year, month }, -1);
      const counted = await this.prisma.focusSession.count({
        where: { userId, year: ended.year, month: ended.month, status: { not: 'discarded' } },
      });
      if (counted === 0) continue;
      const added = await this.notifications.enqueue(this.prisma, {
        userId,
        category: 'monthlyRecapReady',
        dedupeKey: `recap:${ended.year}-${ended.month}`,
        subject: `${ended.year}-${ended.month}`,
        copy: { category: 'monthlyRecapReady', year: ended.year, month: ended.month },
        link: notificationLinks.recap(ended.year, ended.month),
        requested: false,
        notBefore: at,
        expiresAt: new Date(at.getTime() + 3 * DAY_MS),
      });
      if (added) planned += 1;
    }
    return planned;
  }
}
