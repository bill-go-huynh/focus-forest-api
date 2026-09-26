import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type {
  PreferencesResponse,
  ReminderSettingDto,
  UpdatePreferencesDto,
} from './dto/preferences.dto.js';
import { isTimedCategory, NOTIFICATION_CATEGORIES } from './notification-categories.js';
import {
  DEFAULT_DISPLAY_PREFERENCES,
  DEFAULT_NOTIFICATION_ENABLED,
  DEFAULT_REMINDER_TIME,
} from './preferences.defaults.js';

// Stores preferences only. Nothing here sends notifications (Phase 18).
@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<PreferencesResponse> {
    const [display, notifications] = await Promise.all([
      this.prisma.userPreferences.findUnique({ where: { userId } }),
      this.prisma.notificationPreference.findMany({ where: { userId } }),
    ]);
    const stored = new Map(notifications.map((row) => [row.category, row]));

    const settings = {} as PreferencesResponse['notifications'];
    for (const category of NOTIFICATION_CATEGORIES) {
      const row = stored.get(category);
      const enabled = row?.enabled ?? DEFAULT_NOTIFICATION_ENABLED;
      settings[category] = isTimedCategory(category)
        ? { enabled, time: row?.time ?? DEFAULT_REMINDER_TIME }
        : { enabled };
    }

    return {
      theme: display?.theme ?? DEFAULT_DISPLAY_PREFERENCES.theme,
      sound: display?.sound ?? DEFAULT_DISPLAY_PREFERENCES.sound,
      haptics: display?.haptics ?? DEFAULT_DISPLAY_PREFERENCES.haptics,
      reducedMotion: display?.reducedMotion ?? DEFAULT_DISPLAY_PREFERENCES.reducedMotion,
      notifications: settings,
    };
  }

  /** Applies every change in one transaction: all of it or none of it. */
  async update(userId: string, changes: UpdatePreferencesDto): Promise<PreferencesResponse> {
    const { notifications, ...display } = changes;

    await this.prisma.$transaction(async (tx) => {
      if (Object.values(display).some((value) => value !== undefined)) {
        await tx.userPreferences.upsert({
          where: { userId },
          create: { userId, ...DEFAULT_DISPLAY_PREFERENCES, ...withoutUndefined(display) },
          update: withoutUndefined(display),
        });
      }

      for (const category of NOTIFICATION_CATEGORIES) {
        const change: ReminderSettingDto | undefined = notifications?.[category];
        if (!change) continue;
        await tx.notificationPreference.upsert({
          where: { userId_category: { userId, category } },
          create: {
            userId,
            category,
            enabled: change.enabled ?? DEFAULT_NOTIFICATION_ENABLED,
            time: change.time ?? DEFAULT_REMINDER_TIME,
          },
          update: withoutUndefined({ enabled: change.enabled, time: change.time }),
        });
      }
    });

    return this.get(userId);
  }
}

function withoutUndefined<T extends object>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
