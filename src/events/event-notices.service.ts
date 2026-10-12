import { Injectable, type OnModuleInit } from '@nestjs/common';

import { JobsService } from '../jobs/jobs.service.js';
import { notificationLinks } from '../notifications/notification-links.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { COMMUNITY_REACHED_JOB } from './community-tree.service.js';
import type { CommunityStage } from './community-tree.dto.js';

/**
 * Event notifications (A6.3, spec §18 Event start / Event ending soon / Badge unlocked).
 * Informational, so the dispatcher keeps them to the day window and the daily limit.
 *
 * - **Start:** everyone who turned it on, when an active event begins.
 * - **Ending soon:** participants only, `notifications.eventEndingSoonHours` before the end. It
 *   is information, never pressure (docs/02): no countdown, no "last chance".
 * - **Community Tree:** when a stage with a badge is reached, the other participants (the one
 *   whose focus reached it sees it in the app).
 *
 * Start and ending notices are planned by the `events.notices` job every quarter hour.
 */

export const EVENT_NOTICES_JOB = 'events.notices';
const SLOT_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

interface ReachedPayload {
  eventId: string;
  stages: CommunityStage[];
  contributorId: string;
}

@Injectable()
export class EventNoticesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerRecurring(EVENT_NOTICES_JOB, SLOT_MS, (slot) => this.plan(slot));
    this.jobs.register(COMMUNITY_REACHED_JOB, (payload) =>
      this.communityReached(payload as ReachedPayload),
    );
    this.notifications.registerRelevance('eventStart', ({ subject, now }) =>
      this.running(subject, now),
    );
    // Only participants are planned for, and joining an event is never undone.
    this.notifications.registerRelevance('eventEndingSoon', ({ subject, now }) =>
      this.running(subject, now),
    );
  }

  /** Enqueues the start and ending-soon notices falling in the quarter hour starting at `slot`. */
  async plan(slot: Date): Promise<number> {
    const end = new Date(slot.getTime() + SLOT_MS);
    const soonMs = (await this.config.active()).get('notifications.eventEndingSoonHours') * HOUR_MS;
    let planned = 0;

    const starting = await this.prisma.event.findMany({
      where: { status: 'active', startsAt: { gte: slot, lt: end } },
    });
    for (const event of starting) {
      const people = await this.prisma.notificationPreference.findMany({
        where: { category: 'eventStart', enabled: true, user: { status: 'active' } },
        select: { userId: true },
      });
      for (const { userId } of people) {
        const added = await this.notifications.enqueue(this.prisma, {
          userId,
          category: 'eventStart',
          dedupeKey: `event-start:${event.id}`,
          subject: event.id,
          copy: { category: 'eventStart', eventName: event.name },
          link: notificationLinks.event(event.id),
          requested: false,
          notBefore: event.startsAt,
          expiresAt: new Date(Math.min(event.startsAt.getTime() + DAY_MS, event.endsAt.getTime())),
        });
        if (added) planned += 1;
      }
    }

    const ending = await this.prisma.event.findMany({
      where: {
        status: 'active',
        endsAt: { gte: new Date(slot.getTime() + soonMs), lt: new Date(end.getTime() + soonMs) },
      },
    });
    for (const event of ending) {
      const people = await this.prisma.eventParticipation.findMany({
        where: {
          eventId: event.id,
          user: {
            status: 'active',
            notificationPreferences: { some: { category: 'eventEndingSoon', enabled: true } },
          },
        },
        select: { userId: true },
      });
      for (const { userId } of people) {
        const added = await this.notifications.enqueue(this.prisma, {
          userId,
          category: 'eventEndingSoon',
          dedupeKey: `event-ending:${event.id}`,
          subject: event.id,
          copy: { category: 'eventEndingSoon', eventName: event.name },
          link: notificationLinks.event(event.id),
          requested: false,
          notBefore: new Date(event.endsAt.getTime() - soonMs),
          expiresAt: event.endsAt,
        });
        if (added) planned += 1;
      }
    }
    return planned;
  }

  /** Tells the other participants about each reached stage that shares a badge. */
  private async communityReached({
    eventId,
    stages,
    contributorId,
  }: ReachedPayload): Promise<void> {
    const milestones = await this.prisma.communityMilestone.findMany({
      where: { eventId, stage: { in: stages }, badgeId: { not: null }, reachedAt: { not: null } },
      include: { badge: true },
    });
    if (milestones.length === 0) return;
    const people = await this.prisma.eventParticipation.findMany({
      where: {
        eventId,
        userId: { not: contributorId },
        user: {
          status: 'active',
          notificationPreferences: { some: { category: 'badgeUnlocked', enabled: true } },
        },
      },
      select: { userId: true },
    });
    for (const milestone of milestones) {
      for (const { userId } of people) {
        await this.notifications.enqueue(this.prisma, {
          userId,
          category: 'badgeUnlocked',
          dedupeKey: `community:${eventId}:${milestone.stage}`,
          subject: eventId,
          copy: { category: 'badgeUnlocked', badgeName: milestone.badge!.name },
          link: notificationLinks.achievements(),
          requested: false,
          notBefore: milestone.reachedAt!,
          expiresAt: new Date(milestone.reachedAt!.getTime() + 3 * DAY_MS),
        });
      }
    }
  }

  private async running(eventId: string | null, now: Date): Promise<boolean> {
    const event = await this.prisma.event.findUnique({ where: { id: eventId ?? '' } });
    return event !== null && event.status === 'active' && now < event.endsAt;
  }
}
