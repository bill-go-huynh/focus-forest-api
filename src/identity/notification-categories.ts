/** The notification categories of spec §18, in spec order. */
export const NOTIFICATION_CATEGORIES = [
  'dailyGoalReminder',
  'scheduledFocusReminder',
  'streakReminder',
  'eventStart',
  'eventEndingSoon',
  'friendInvite',
  'focusRoomInvite',
  'challengeUpdate',
  'badgeUnlocked',
  'monthlyRecapReady',
] as const;

export type NotificationCategoryKey = (typeof NOTIFICATION_CATEGORIES)[number];

/** Reminders have a user-set local time (docs/11_ACCESSIBILITY.md → Notification control). */
export const TIMED_NOTIFICATION_CATEGORIES = [
  'dailyGoalReminder',
  'scheduledFocusReminder',
  'streakReminder',
] as const satisfies readonly NotificationCategoryKey[];

export type TimedNotificationCategoryKey = (typeof TIMED_NOTIFICATION_CATEGORIES)[number];

export function isTimedCategory(
  category: NotificationCategoryKey,
): category is TimedNotificationCategoryKey {
  return (TIMED_NOTIFICATION_CATEGORIES as readonly string[]).includes(category);
}

/** A local 24-hour time, "HH:MM". */
export const REMINDER_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isReminderTime(value: unknown): value is string {
  return typeof value === 'string' && REMINDER_TIME.test(value);
}
