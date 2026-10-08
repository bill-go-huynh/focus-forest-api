import { addDays, isLocalDate, type LocalDate } from '../common/local-date.js';

/**
 * Product analytics for the Core Loop Checkpoint (CR.1; docs/08 §6: privacy-respecting, to
 * measure return behavior). Operational data only: never product truth, never read by a product
 * feature (Insights, growth, streaks, rewards stay derived from sessions). A closed allowlist of
 * event names and of integer properties: no free text (notes, topic names, display names), no
 * exact durations. Pure.
 */

export const ANALYTICS_EVENT_NAMES = [
  'app_opened',
  'app_foregrounded',
  'focus_started',
  'focus_cancelled',
  'tree_details_opened',
  'forest_opened',
  'recap_opened',
  'insights_opened',
] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export const ANALYTICS_PLATFORMS = ['ios', 'android', 'web'] as const;

/** At most this many events per request. */
export const MAX_EVENTS_PER_BATCH = 50;
/** Older events are not kept: a device offline longer has nothing useful left to say. */
const MAX_AGE_DAYS = 30;
/** A device clock may run a little ahead. */
const MAX_SKEW_MS = 5 * 60_000;

/** The integer properties each event may carry, with their ranges. Anything else is dropped. */
const PROPS: Record<AnalyticsEventName, Record<string, readonly [min: number, max: number]>> = {
  app_opened: {},
  app_foregrounded: {},
  focus_started: { plannedMinutes: [1, 600] },
  focus_cancelled: { elapsedMinutes: [0, 24 * 60] },
  tree_details_opened: {},
  forest_opened: {},
  recap_opened: { year: [2000, 2100], month: [1, 12] },
  insights_opened: {},
};

/** Cancelled focus is kept in coarse buckets (0, 5, 10, 15, 30, 60+), never to the minute. */
export function bucketMinutes(minutes: number): number {
  const buckets = [60, 30, 15, 10, 5];
  return buckets.find((bucket) => minutes >= bucket) ?? 0;
}

export interface IncomingEvent {
  id: string;
  name: string;
  occurredAt: string;
  localDate: string;
  platform: string;
  appVersion: string;
  props?: Record<string, unknown>;
}

export interface AcceptedEvent {
  id: string;
  name: AnalyticsEventName;
  occurredAt: Date;
  localDate: LocalDate;
  platform: (typeof ANALYTICS_PLATFORMS)[number];
  appVersion: string;
  props: Record<string, number>;
}

const isOneOf = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/**
 * The row to store for an event, or null when it is ignored: an unknown name or platform (a newer
 * app talking to an older API), an instant outside the window, or a local date more than a day
 * from the instant's UTC date (no time zone is that far).
 */
export function acceptEvent(event: IncomingEvent, now: Date): AcceptedEvent | null {
  if (!isOneOf(ANALYTICS_EVENT_NAMES, event.name)) return null;
  if (!isOneOf(ANALYTICS_PLATFORMS, event.platform)) return null;
  const occurredAt = new Date(event.occurredAt);
  const at = occurredAt.getTime();
  if (Number.isNaN(at)) return null;
  if (at > now.getTime() + MAX_SKEW_MS) return null;
  if (at < now.getTime() - MAX_AGE_DAYS * 86_400_000) return null;
  if (!isLocalDate(event.localDate)) return null;
  const utcDate: LocalDate = occurredAt.toISOString().slice(0, 10);
  if (event.localDate < addDays(utcDate, -1) || event.localDate > addDays(utcDate, 1)) {
    return null;
  }

  const props: Record<string, number> = {};
  for (const [key, [min, max]] of Object.entries(PROPS[event.name])) {
    const value = event.props?.[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      continue;
    }
    props[key] = key === 'elapsedMinutes' ? bucketMinutes(value) : value;
  }
  return {
    id: event.id,
    name: event.name,
    occurredAt,
    localDate: event.localDate,
    platform: event.platform,
    appVersion: event.appVersion,
    props,
  };
}
