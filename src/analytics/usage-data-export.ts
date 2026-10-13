import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The person's own usage events, for their data export (A7.1). Reading the events stays inside
 * the analytics module (CR.1 boundary); the export only receives them, and nothing in the
 * product decides anything from them.
 */
@Injectable()
export class UsageDataExport {
  constructor(private readonly prisma: PrismaService) {}

  async of(userId: string) {
    const events = await this.prisma.analyticsEvent.findMany({
      where: { userId },
      orderBy: { occurredAt: 'asc' },
      select: {
        name: true,
        occurredAt: true,
        receivedAt: true,
        localDate: true,
        platform: true,
        appVersion: true,
        props: true,
      },
    });
    return events.map((event) => ({
      ...event,
      occurredAt: event.occurredAt.toISOString(),
      receivedAt: event.receivedAt.toISOString(),
      localDate: event.localDate.toISOString().slice(0, 10),
    }));
  }
}
