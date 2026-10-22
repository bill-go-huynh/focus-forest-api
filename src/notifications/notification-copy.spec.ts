import { NOTIFICATION_CATEGORIES } from '../identity/notification-categories.js';
import {
  guiltProblems,
  type NotificationCopyInput,
  notificationCopy,
} from './notification-copy.js';

/** One example of every category's copy. */
const EXAMPLES: NotificationCopyInput[] = [
  { category: 'dailyGoalReminder', goalMinutes: 30 },
  { category: 'scheduledFocusReminder' },
  { category: 'streakReminder', streakDays: 6 },
  { category: 'friendInvite', friendName: 'Mai' },
  { category: 'focusRoomInvite', friendName: 'Mai', roomName: 'Morning reading' },
  { category: 'challengeUpdate', kind: 'completed' },
  { category: 'challengeUpdate', kind: 'joined', friendName: 'Kai' },
  { category: 'badgeUnlocked', badgeName: 'Study Oak Seedling' },
  { category: 'monthlyRecapReady', year: 2026, month: 10 },
];

describe('notification copy (docs/02 rule 4, docs/11 Notification control)', () => {
  it('covers every category', () => {
    expect(new Set(EXAMPLES.map((e) => e.category))).toEqual(new Set(NOTIFICATION_CATEGORIES));
  });

  it.each(EXAMPLES)('is plain and kind: $category', (input) => {
    const { title, body } = notificationCopy(input);
    expect(title.trim()).not.toBe('');
    expect(body.trim()).not.toBe('');
    expect(title.length).toBeLessThanOrEqual(50);
    expect(body.length).toBeLessThanOrEqual(140);
    expect(guiltProblems(`${title} ${body}`)).toEqual([]);
    expect(`${title} ${body}`).not.toMatch(/!/);
  });

  it('names what it is about', () => {
    expect(notificationCopy(EXAMPLES[7]!).title).toContain('Study Oak Seedling');
    expect(notificationCopy(EXAMPLES[4]!).title).toContain('Mai');
    expect(notificationCopy(EXAMPLES[4]!).body).toContain('Morning reading');
    expect(notificationCopy(EXAMPLES[8]!).title).toContain('October');
    expect(notificationCopy(EXAMPLES[0]!).body).toContain('30 minutes');
  });

  it('shortens long names so the text stays readable', () => {
    const { title } = notificationCopy({
      category: 'badgeUnlocked',
      badgeName: 'A very long badge name that keeps going and going and going',
    });
    expect(title.length).toBeLessThanOrEqual(50);
    expect(title).toContain('…');
  });

  it('finds guilt and pressure wording', () => {
    for (const phrase of [
      "Don't break your streak",
      'You missed yesterday',
      'Your streak is at risk',
      'You will lose your progress',
      'Hurry, last chance',
      'You failed your goal',
      '0 minutes today',
      'You are falling behind',
    ]) {
      expect(guiltProblems(phrase)).not.toEqual([]);
    }
    expect(guiltProblems('Your tree is ready when you are.')).toEqual([]);
    expect(guiltProblems('A closer look at your forest')).toEqual([]);
  });
});
