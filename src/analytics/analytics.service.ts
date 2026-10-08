import { Injectable } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { acceptEvent, type AcceptedEvent } from './analytics-events.js';
import type { AnalyticsBatchDto, AnalyticsBatchResponse } from './dto/analytics-events.dto.js';

/**
 * Stores product analytics events (CR.1). Write only: nothing in the product reads them; the
 * checkpoint metrics (admin) do. Idempotent by the client's event id; an id already stored is
 * never overwritten, whoever sent it.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async ingest(userId: string, batch: AnalyticsBatchDto): Promise<AnalyticsBatchResponse> {
    const preferences = await this.prisma.userPreferences.findUnique({
      where: { userId },
      select: { shareUsageData: true },
    });
    if (preferences && !preferences.shareUsageData) {
      return { accepted: 0, ignored: batch.events.length };
    }
    const now = this.clock.now();
    const accepted = batch.events
      .map((event) => acceptEvent(event, now))
      .filter((event): event is AcceptedEvent => event !== null);
    if (accepted.length > 0) {
      await this.prisma.analyticsEvent.createMany({
        data: accepted.map((event) => ({
          ...event,
          userId,
          localDate: new Date(`${event.localDate}T00:00:00.000Z`),
          receivedAt: now,
        })),
        skipDuplicates: true,
      });
    }
    return { accepted: accepted.length, ignored: batch.events.length - accepted.length };
  }
}
