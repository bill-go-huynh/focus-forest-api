import { localDateOf } from '../sessions/attribution/calendar.js';
import { instantAt, localDayAfter, localMinutesOf } from './local-time.js';

/**
 * Whether one notification is sent now (spec §18, docs/02 Notifications, docs/11 Notification
 * control). The one rule set every notification goes through, whatever produced it.
 *
 * 1. Never to a suspended or banned person, never in a category they have not turned on.
 * 2. Never when it is no longer timely or relevant, or when there is no device.
 * 3. Never during focus: it waits for the session to end (docs/02).
 * 4. Informational notices (events, social, badges, recaps) only inside the day window, and at
 *    most `maxUnrequestedPerDay` a local day; beyond it they are dropped, not saved for later.
 *    Reminders the person set themselves are requested: they keep their time and are not counted.
 */

export interface DeliveryFacts {
  now: Date;
  timeZone: string;
  userActive: boolean;
  categoryEnabled: boolean;
  deviceCount: number;
  relevant: boolean;
  requested: boolean;
  expiresAt: Date;
  /** When the person's focus ends (a focus lease with its grace, or a room); null if not focusing. */
  focusUntil: Date | null;
  unrequestedSentToday: number;
  maxUnrequestedPerDay: number;
  informationalHours: { start: number; end: number };
}

export type SkipReason =
  'user_inactive' | 'category_off' | 'expired' | 'not_relevant' | 'no_device' | 'daily_limit';

export type Delivery =
  | { action: 'send' }
  | { action: 'defer'; until: Date; cause: 'focus' | 'day_window' }
  | { action: 'skip'; reason: SkipReason };

export function decideDelivery(facts: DeliveryFacts): Delivery {
  const skip = (reason: SkipReason): Delivery => ({ action: 'skip', reason });
  const now = facts.now.getTime();
  if (!facts.userActive) return skip('user_inactive');
  if (!facts.categoryEnabled) return skip('category_off');
  if (now >= facts.expiresAt.getTime()) return skip('expired');
  if (!facts.relevant) return skip('not_relevant');
  if (facts.deviceCount === 0) return skip('no_device');
  if (facts.focusUntil && facts.focusUntil.getTime() > now) {
    return { action: 'defer', until: facts.focusUntil, cause: 'focus' };
  }
  if (!facts.requested) {
    const opens = informationalWait(facts.now, facts.timeZone, facts.informationalHours);
    if (opens) return { action: 'defer', until: opens, cause: 'day_window' };
    if (facts.unrequestedSentToday >= facts.maxUnrequestedPerDay) return skip('daily_limit');
  }
  return { action: 'send' };
}

/** When the day window next opens, or null while it is open. Hours are local, [start, end). */
export function informationalWait(
  now: Date,
  timeZone: string,
  hours: { start: number; end: number },
): Date | null {
  const minutes = localMinutesOf(now, timeZone);
  if (minutes >= hours.start * 60 && minutes < hours.end * 60) return null;
  const date =
    minutes < hours.start * 60 ? localDateOf(now, timeZone) : localDayAfter(now, timeZone);
  return instantAt(date, hours.start * 60, timeZone);
}
