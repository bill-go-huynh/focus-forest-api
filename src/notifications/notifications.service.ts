import { Injectable, type OnModuleInit } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import type { NotificationCategory, Prisma } from '../generated/prisma/client.js';
import type { NotificationCategoryKey } from '../identity/notification-categories.js';
import { JobsService } from '../jobs/jobs.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { roomPhase } from '../rooms/room-rules.js';
import { localDateOf, startOfLocalDate } from '../sessions/attribution/calendar.js';
import { type NotificationCopyInput, notificationCopy } from './notification-copy.js';
import { isKnownLink } from './notification-links.js';
import { decideDelivery } from './notification-rules.js';
import { PushTransport } from './push-transport.js';

/**
 * The notification outbox and its dispatcher (A6.1). Producers only `enqueue`; one dispatcher
 * applies `decideDelivery` to every notification, so no feature can bypass the person's choices,
 * focus, the day window, or the daily limit. Rows are kept with what became of them.
 */

export interface NewNotification {
  userId: string;
  category: NotificationCategoryKey;
  /** One notification per user and key. */
  dedupeKey: string;
  subject: string | null;
  copy: NotificationCopyInput;
  link: string;
  requested: boolean;
  notBefore: Date;
  expiresAt: Date;
}

/** Whether a notification still makes sense when it is about to be sent. */
export type RelevanceCheck = (notification: {
  userId: string;
  subject: string | null;
  dedupeKey: string;
  now: Date;
}) => Promise<boolean>;

export interface DispatchSummary {
  sent: number;
  skipped: number;
  deferred: number;
  failed: number;
}

export interface NotificationLimits {
  maxUnrequestedPerDay: number;
  informationalHours: { start: number; end: number };
  focusLeaseGraceMinutes: number;
}

type Db = Prisma.TransactionClient;

const MIN = 60_000;
const DISPATCH_LOCK_MS = 2 * MIN;
/** Expo's receipts are ready within minutes; read them a quarter of an hour later. */
const RECEIPTS_AFTER_MS = 15 * MIN;
export const PUSH_RECEIPTS_JOB = 'push.receipts';

interface ClaimedNotification {
  id: bigint;
  userId: string;
  category: NotificationCategory;
  dedupeKey: string;
  subject: string | null;
  title: string;
  body: string;
  link: string;
  requested: boolean;
  expiresAt: Date;
}

interface ReceiptsPayload {
  tickets: { id: string; token: string }[];
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly relevance = new Map<NotificationCategoryKey, RelevanceCheck>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly jobs: JobsService,
    private readonly transport: PushTransport,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.jobs.register(PUSH_RECEIPTS_JOB, (payload) =>
      this.readReceipts(payload as ReceiptsPayload),
    );
  }

  /** The module that produces a category may say when it stops being relevant. */
  registerRelevance(category: NotificationCategoryKey, check: RelevanceCheck): void {
    this.relevance.set(category, check);
  }

  async limits(): Promise<NotificationLimits> {
    const config = await this.config.active();
    return {
      maxUnrequestedPerDay: config.get('notifications.maxUnrequestedPerDay'),
      informationalHours: config.get('notifications.informationalHours'),
      focusLeaseGraceMinutes: config.get('notifications.focusLeaseGraceMinutes'),
    };
  }

  /** Stores a notification to dispatch. False when one with the same key exists. */
  async enqueue(db: Db, notification: NewNotification): Promise<boolean> {
    if (!isKnownLink(notification.link)) {
      throw new Error(`Unknown notification link: ${notification.link}`);
    }
    if (notification.copy.category !== notification.category) {
      throw new Error(
        `The copy is for ${notification.copy.category}, not ${notification.category}.`,
      );
    }
    const { title, body } = notificationCopy(notification.copy);
    const { count } = await db.notificationOutbox.createMany({
      data: {
        userId: notification.userId,
        category: notification.category,
        dedupeKey: notification.dedupeKey,
        subject: notification.subject,
        title,
        body,
        link: notification.link,
        requested: notification.requested,
        notBefore: notification.notBefore,
        expiresAt: notification.expiresAt,
        createdAt: this.clock.now(),
      },
      skipDuplicates: true,
    });
    return count === 1;
  }

  /** Decides every notification due at `now`: sends, skips with a reason, or defers it. */
  async dispatchDue(now: Date, limit = 100): Promise<DispatchSummary> {
    const summary: DispatchSummary = { sent: 0, skipped: 0, deferred: 0, failed: 0 };
    const claimed = await this.claim(now, limit);
    if (claimed.length === 0) return summary;
    const limits = await this.limits();
    const maxPauseMinutes = (await this.config.active()).get('session.maxPauseMinutes');

    for (const notification of claimed) {
      const user = await this.prisma.user.findUnique({
        where: { id: notification.userId },
        select: { status: true, timezone: true },
      });
      const timeZone = user?.timezone ?? 'UTC';
      const [preference, devices, focusUntil, unrequestedSentToday, relevant] = await Promise.all([
        this.prisma.notificationPreference.findUnique({
          where: {
            userId_category: { userId: notification.userId, category: notification.category },
          },
          select: { enabled: true },
        }),
        this.prisma.pushDevice.findMany({
          where: { userId: notification.userId },
          select: { token: true },
          orderBy: { token: 'asc' },
        }),
        this.focusUntil(notification.userId, now, limits.focusLeaseGraceMinutes, maxPauseMinutes),
        this.prisma.notificationOutbox.count({
          where: {
            userId: notification.userId,
            status: 'sent',
            requested: false,
            sentAt: { gte: startOfLocalDate(localDateOf(now, timeZone), timeZone) },
          },
        }),
        this.isRelevant(notification, now),
      ]);

      const decision = decideDelivery({
        now,
        timeZone,
        userActive: user?.status === 'active',
        categoryEnabled: preference?.enabled ?? false,
        deviceCount: devices.length,
        relevant,
        requested: notification.requested,
        expiresAt: notification.expiresAt,
        focusUntil,
        unrequestedSentToday,
        maxUnrequestedPerDay: limits.maxUnrequestedPerDay,
        informationalHours: limits.informationalHours,
      });

      if (decision.action === 'skip') {
        await this.settle(notification.id, { status: 'skipped', reason: decision.reason });
        summary.skipped += 1;
      } else if (decision.action === 'defer') {
        await this.prisma.notificationOutbox.update({
          where: { id: notification.id },
          data: {
            notBefore: decision.until,
            heldForFocus: decision.cause === 'focus',
            lockedUntil: null,
          },
        });
        summary.deferred += 1;
      } else if (
        await this.send(
          notification,
          devices.map((d) => d.token),
          now,
        )
      ) {
        summary.sent += 1;
      } else {
        summary.failed += 1;
      }
    }
    return summary;
  }

  /** Pushes to every device; sent if any accepted it. Devices Expo no longer knows are removed. */
  private async send(
    notification: ClaimedNotification,
    tokens: string[],
    now: Date,
  ): Promise<boolean> {
    const tickets = await this.transport.send(
      tokens.map((to) => ({
        to,
        title: notification.title,
        body: notification.body,
        data: {
          link: notification.link,
          category: notification.category,
          recipient: notification.userId,
        },
      })),
    );
    const accepted: { id: string; token: string }[] = [];
    const gone: string[] = [];
    let firstError: string | null = null;
    tickets.forEach((ticket, i) => {
      const token = tokens[i]!;
      if (ticket.status === 'ok') accepted.push({ id: ticket.id, token });
      else {
        firstError ??= ticket.error;
        if (ticket.error === 'DeviceNotRegistered') gone.push(token);
      }
    });
    if (gone.length > 0)
      await this.prisma.pushDevice.deleteMany({ where: { token: { in: gone } } });

    if (accepted.length === 0) {
      await this.settle(notification.id, { status: 'failed', reason: firstError ?? 'NoTicket' });
      return false;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.notificationOutbox.update({
        where: { id: notification.id },
        data: { status: 'sent', sentAt: now, lockedUntil: null, reason: null },
      });
      await this.jobs.enqueue(tx, {
        kind: PUSH_RECEIPTS_JOB,
        runAt: new Date(now.getTime() + RECEIPTS_AFTER_MS),
        payload: { tickets: accepted } satisfies ReceiptsPayload,
      });
    });
    return true;
  }

  private async readReceipts(payload: ReceiptsPayload): Promise<void> {
    const receipts = await this.transport.receipts(payload.tickets.map((ticket) => ticket.id));
    const gone = payload.tickets
      .filter((ticket) => {
        const receipt = receipts[ticket.id];
        return receipt?.status === 'error' && receipt.error === 'DeviceNotRegistered';
      })
      .map((ticket) => ticket.token);
    if (gone.length > 0)
      await this.prisma.pushDevice.deleteMany({ where: { token: { in: gone } } });
  }

  /**
   * When the person's focus ends: a focus lease (plus its grace for pauses) or a Focus Together
   * room that is counting down or focusing. Null when they are not focusing.
   */
  private async focusUntil(
    userId: string,
    now: Date,
    graceMinutes: number,
    maxPauseMinutes: number,
  ): Promise<Date | null> {
    const [lease, places] = await Promise.all([
      this.prisma.focusLease.findUnique({ where: { userId }, select: { endsAt: true } }),
      this.prisma.roomParticipant.findMany({
        where: { userId, leftAt: null, completedAt: null, room: { status: 'in_session' } },
        select: { room: true },
      }),
    ]);
    const ends: number[] = [];
    if (lease) ends.push(lease.endsAt.getTime() + graceMinutes * MIN);
    for (const { room } of places) {
      const phase = roomPhase(room, now, maxPauseMinutes);
      if ((phase === 'countdown' || phase === 'focusing') && room.startsAt) {
        ends.push(room.startsAt.getTime() + (room.durationMinutes + maxPauseMinutes) * MIN);
      }
    }
    const until = Math.max(...ends, 0);
    return until > now.getTime() ? new Date(until) : null;
  }

  private async isRelevant(notification: ClaimedNotification, now: Date): Promise<boolean> {
    const check = this.relevance.get(notification.category);
    if (!check) return true;
    return check({
      userId: notification.userId,
      subject: notification.subject,
      dedupeKey: notification.dedupeKey,
      now,
    });
  }

  private settle(
    id: bigint,
    outcome: { status: 'skipped' | 'failed'; reason: string },
  ): Promise<unknown> {
    return this.prisma.notificationOutbox.update({
      where: { id },
      data: { ...outcome, lockedUntil: null },
    });
  }

  /** Claims due notifications, in order (SKIP LOCKED, as `JobsService` claims jobs). */
  private async claim(now: Date, limit: number): Promise<ClaimedNotification[]> {
    const lockedUntil = new Date(now.getTime() + DISPATCH_LOCK_MS);
    const ids = await this.prisma.$queryRaw<{ id: bigint }[]>`
      WITH due AS (
        SELECT "id" FROM "notification_outbox"
        WHERE "status" = 'pending' AND "not_before" <= ${now}
          AND ("locked_until" IS NULL OR "locked_until" <= ${now})
        ORDER BY "not_before", "id"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "notification_outbox" AS o SET "locked_until" = ${lockedUntil}
      FROM due
      WHERE o."id" = due."id"
      RETURNING o."id"`;
    if (ids.length === 0) return [];
    return this.prisma.notificationOutbox.findMany({
      where: { id: { in: ids.map((row) => row.id) } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        userId: true,
        category: true,
        dedupeKey: true,
        subject: true,
        title: true,
        body: true,
        link: true,
        requested: true,
        expiresAt: true,
      },
    });
  }
}
