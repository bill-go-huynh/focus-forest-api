/**
 * Every notification's text, in one place (docs/02 rule 4, docs/11 Notification control):
 * plain and kind, an invitation rather than a demand, no guilt, no numbers that shame, no
 * exclamation marks. Names are shortened so the text stays readable on a lock screen.
 */

export type NotificationCopyInput =
  | { category: 'dailyGoalReminder'; goalMinutes: number }
  | { category: 'scheduledFocusReminder' }
  | { category: 'streakReminder'; streakDays: number }
  | { category: 'eventStart'; eventName: string }
  | { category: 'eventEndingSoon'; eventName: string }
  | { category: 'friendInvite'; friendName: string }
  | { category: 'focusRoomInvite'; friendName: string; roomName: string }
  | { category: 'challengeUpdate'; kind: 'completed' }
  | { category: 'challengeUpdate'; kind: 'joined'; friendName: string }
  | { category: 'badgeUnlocked'; badgeName: string }
  | { category: 'monthlyRecapReady'; year: number; month: number };

export interface NotificationCopy {
  title: string;
  body: string;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A name of at most `max` characters, ending in "…" when shortened. */
function short(name: string, max = 24): string {
  const trimmed = name.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function notificationCopy(input: NotificationCopyInput): NotificationCopy {
  switch (input.category) {
    case 'dailyGoalReminder':
      return {
        title: 'A little focus today?',
        body: `Your daily goal is ${input.goalMinutes} minutes. Your tree is ready when you are.`,
      };
    case 'scheduledFocusReminder':
      return {
        title: 'Time to focus',
        body: 'You planned a focus session for now. Your tree is ready when you are.',
      };
    case 'streakReminder':
      return {
        title: 'Your forest is waiting',
        body: `${input.streakDays} days of steady focus so far. A short session today keeps the rhythm, if it suits you.`,
      };
    case 'eventStart':
      return {
        title: `${short(input.eventName)} has begun`,
        body: 'Join whenever you like. Your usual focus counts toward its missions.',
      };
    case 'eventEndingSoon':
      return {
        title: `${short(input.eventName)} ends soon`,
        body: 'It wraps up soon. Thank you for taking part.',
      };
    case 'friendInvite':
      return {
        title: `${short(input.friendName, 20)} invited you to a challenge`,
        body: "Take a look together, if you'd like.",
      };
    case 'focusRoomInvite':
      return {
        title: `${short(input.friendName, 20)} invited you to focus`,
        body: `The room "${short(input.roomName, 40)}" is gathering. Join if you have time.`,
      };
    case 'challengeUpdate':
      return input.kind === 'completed'
        ? { title: 'Your challenge is complete', body: 'You reached it together. Nicely done.' }
        : {
            title: `${short(input.friendName, 20)} joined your challenge`,
            body: "You're working toward it together now.",
          };
    case 'badgeUnlocked':
      return {
        title: `A new badge: ${short(input.badgeName, 30)}`,
        body: 'It is in your collection now.',
      };
    case 'monthlyRecapReady':
      return {
        title: `Your ${MONTHS[input.month - 1] ?? ''} recap is ready`,
        body: 'Take a look back at the tree you grew this month.',
      };
  }
}

/** Wording that shames, threatens a loss, or pressures (docs/02 rule 4). */
const GUILT = [
  /\bdon'?t (break|lose|let)\b/i,
  /\bmiss(ed|ing)?\b/i,
  /\blos(e|es|ing|t)\b/i,
  /\bfail(ed|ing|s)?\b/i,
  /\bhurry\b/i,
  /\blast chance\b/i,
  /\bat risk\b/i,
  /\bbehind\b/i,
  /\btoo late\b/i,
  /(^|\D)0 (minutes|sessions|days)\b/i,
];

export function guiltProblems(text: string): string[] {
  return GUILT.filter((pattern) => pattern.test(text)).map(
    (pattern) => `"${text}" matches ${String(pattern)}`,
  );
}

/** How a person is named in someone else's notification. */
export function nameOf(person: { displayName: string | null; username: string | null }): string {
  return person.displayName ?? person.username ?? 'A friend';
}
