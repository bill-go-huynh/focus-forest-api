import {
  isReminderTime,
  NOTIFICATION_CATEGORIES,
  TIMED_NOTIFICATION_CATEGORIES,
} from './notification-categories.js';

describe('notification categories', () => {
  it('are the eight categories of spec §18 without the event notices (owner, 2026-10-22)', () => {
    expect([...NOTIFICATION_CATEGORIES]).toEqual([
      'dailyGoalReminder',
      'scheduledFocusReminder',
      'streakReminder',
      'friendInvite',
      'focusRoomInvite',
      'challengeUpdate',
      'badgeUnlocked',
      'monthlyRecapReady',
    ]);
  });

  it('give a user-set time only to the reminders', () => {
    expect([...TIMED_NOTIFICATION_CATEGORIES]).toEqual([
      'dailyGoalReminder',
      'scheduledFocusReminder',
      'streakReminder',
    ]);
  });
});

describe('isReminderTime', () => {
  it.each(['00:00', '07:30', '19:05', '23:59'])('accepts the local time %s', (time) => {
    expect(isReminderTime(time)).toBe(true);
  });

  it.each(['24:00', '7:30', '07:60', '07:30:00', '7pm', '', ' 07:30', 730, null])(
    'rejects %j',
    (time) => {
      expect(isReminderTime(time)).toBe(false);
    },
  );
});
