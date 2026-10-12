import { Injectable, type OnModuleInit } from '@nestjs/common';

import { GoalsService } from '../consistency/goals.service.js';
import { StreakService } from '../consistency/streak.service.js';
import {
  TIMED_NOTIFICATION_CATEGORIES,
  type TimedNotificationCategoryKey,
} from '../identity/notification-categories.js';
import { JobsService } from '../jobs/jobs.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { localDateOf } from '../sessions/attribution/calendar.js';
import { instantAt, minutesOfReminderTime } from './local-time.js';
import type { NotificationCopyInput } from './notification-copy.js';
import { notificationLinks } from './notification-links.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Reminders (A6.2; spec §18, docs/11 Notification control): the daily goal, scheduled focus, and
 * streak reminders at the time each person chose, in their time zone.
 *
 * A `reminders.plan` job runs every quarter hour and enqueues the reminders whose local time
 * falls in it, then schedules the next quarter. Reminders are requested notifications: they keep
 * their time and are not counted against the daily limit, but each category is sent at most once
 * a local day. When one is about to be sent, it is dropped if it no longer makes sense: the time
 * was changed, today's goal is met, today is a rest day, or there is no streak to keep.
 */

export const PLAN_JOB = 'reminders.plan';
const SLOT_MS = 15 * 60_000;
/** A reminder held back by focus for longer than this is no longer timely. */
const REMINDER_LIFETIME_MS = 2 * 60 * 60_000;

/** `subject` of a reminder: its local date and time, "YYYY-MM-DD HH:MM". */
const subjectOf = (date: string, time: string) => `${date} ${time}`;
const dedupeKeyOf = (category: string, date: string, time: string) =>
  `reminder:${category}:${date}:${time}`;

@Injectable()
export class RemindersService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly goals: GoalsService,
    private readonly streak: StreakService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerRecurring(PLAN_JOB, SLOT_MS, (slot) => this.plan(slot));
    for (const category of TIMED_NOTIFICATION_CATEGORIES) {
      this.notifications.registerRelevance(category, (notification) =>
        this.stillRelevant(category, notification.userId, notification.subject),
      );
    }
  }

  /** Enqueues every reminder whose local time falls in the quarter hour starting at `slot`. */
  async plan(slot: Date): Promise<number> {
    const end = slot.getTime() + SLOT_MS;
    const preferences = await this.prisma.notificationPreference.findMany({
      where: {
        category: { in: [...TIMED_NOTIFICATION_CATEGORIES] },
        enabled: true,
        time: { not: null },
        user: { status: 'active', timezone: { not: null } },
      },
      select: { userId: true, category: true, time: true, user: { select: { timezone: true } } },
    });

    let planned = 0;
    for (const preference of preferences) {
      const time = preference.time!;
      const timeZone = preference.user.timezone!;
      // Every time zone's offset is a whole quarter hour, so a quarter starting on the hour's
      // quarters lies within one local date.
      const date = localDateOf(slot, timeZone);
      const at = instantAt(date, minutesOfReminderTime(time), timeZone);
      if (at.getTime() < slot.getTime() || at.getTime() >= end) continue;
      const category = preference.category as TimedNotificationCategoryKey;
      const copy = await this.copyFor(category, preference.userId);
      if (!copy) continue;
      const added = await this.notifications.enqueue(this.prisma, {
        userId: preference.userId,
        category,
        dedupeKey: dedupeKeyOf(category, date, time),
        subject: subjectOf(date, time),
        copy,
        link: notificationLinks.home(),
        requested: true,
        notBefore: at,
        expiresAt: new Date(at.getTime() + REMINDER_LIFETIME_MS),
      });
      if (added) planned += 1;
    }
    return planned;
  }

  /** The reminder's text, or null when there is nothing kind to say (no streak to keep). */
  private async copyFor(
    category: TimedNotificationCategoryKey,
    userId: string,
  ): Promise<NotificationCopyInput | null> {
    switch (category) {
      case 'dailyGoalReminder':
        return { category, goalMinutes: (await this.goals.view(userId)).daily.minutes };
      case 'scheduledFocusReminder':
        return { category };
      case 'streakReminder': {
        const streakDays = (await this.streak.view(userId)).current;
        return streakDays > 0 ? { category, streakDays } : null;
      }
    }
  }

  private async stillRelevant(
    category: TimedNotificationCategoryKey,
    userId: string,
    subject: string | null,
  ): Promise<boolean> {
    const [date = '', time = ''] = (subject ?? '').split(' ');
    const preference = await this.prisma.notificationPreference.findUnique({
      where: { userId_category: { userId, category: category } },
      select: { time: true },
    });
    if (preference?.time !== time) return false;
    const sentToday = await this.prisma.notificationOutbox.count({
      where: {
        userId,
        status: 'sent',
        dedupeKey: { startsWith: `reminder:${category}:${date}:` },
      },
    });
    if (sentToday > 0) return false;

    const streak = await this.streak.view(userId);
    if (streak.today === 'rest') return false;
    switch (category) {
      case 'dailyGoalReminder':
        return !(await this.goals.view(userId)).daily.today.completed;
      case 'scheduledFocusReminder':
        return true;
      case 'streakReminder':
        // The planner only words a streak of one day or more.
        return streak.today === 'pending';
    }
  }
}
