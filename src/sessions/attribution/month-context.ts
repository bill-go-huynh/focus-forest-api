import {
  addMonths,
  localDateOf,
  localMonthOf,
  monthIndex,
  monthStart,
  type MonthRef,
} from './calendar.js';

/**
 * One month of one user's timeline (docs/06_DOMAIN_MODEL.md → Time and attribution): the
 * UTC interval [startsAt, endsAt) and the time zone frozen when the context was created.
 * Contexts of adjacent months share their boundary, so an instant belongs to one month.
 */
export interface MonthContext extends MonthRef {
  timeZone: string;
  startsAt: Date;
  endsAt: Date;
}

/** Where a session belongs: its month context, and its real local date in that context. */
export interface SessionAttribution extends MonthRef {
  /** "YYYY-MM-DD" in the context's time zone. Near a time zone change it can fall outside the month. */
  localDate: string;
  timeZone: string;
}

/** A month context must be created, and the user has no time zone to create it with. */
export class TimezoneRequiredError extends Error {
  override name = 'TimezoneRequiredError';
  readonly code = 'timezone_required';

  constructor() {
    super('Set your time zone to save sessions.');
  }
}

export interface PlanInput {
  /** The session's start. No existing context contains it. */
  instant: Date;
  profileTimeZone: string | null;
  /** The nearest existing context that ends at or before the instant. */
  previous: MonthContext | null;
  /** The nearest existing context that starts after the instant. */
  next: MonthContext | null;
}

/**
 * The context to create for an instant no existing context contains.
 *
 * - Its time zone is the profile's, frozen from now on.
 * - Its month is the instant's month in that time zone, kept strictly between the
 *   neighbouring contexts: after a time zone change the instant can still read as the
 *   previous month (westward) or already the next one (eastward), but a month that already
 *   has a context never gets a second one.
 * - It starts where the previous month ends and ends where the next month starts, when those
 *   months exist; otherwise at its own local month boundaries. Existing boundaries never move.
 */
export function planMonthContext({
  instant,
  profileTimeZone,
  previous,
  next,
}: PlanInput): MonthContext {
  if (!profileTimeZone) throw new TimezoneRequiredError();

  let index = monthIndex(localMonthOf(instant, profileTimeZone));
  if (previous) index = Math.max(index, monthIndex(previous) + 1);
  if (next) index = Math.min(index, monthIndex(next) - 1);
  const month = addMonths({ year: 0, month: 1 }, index);

  const startsAt =
    previous && monthIndex(previous) === index - 1
      ? previous.endsAt
      : monthStart(month, profileTimeZone);
  const endsAt =
    next && monthIndex(next) === index + 1
      ? next.startsAt
      : monthStart(addMonths(month, 1), profileTimeZone);

  return { ...month, timeZone: profileTimeZone, startsAt, endsAt };
}

/** The attribution of an instant inside a context: its month, and its real local date. */
export function attributeInContext(context: MonthContext, instant: Date): SessionAttribution {
  if (instant < context.startsAt || instant >= context.endsAt) {
    throw new Error(
      `${instant.toISOString()} is outside the ${context.year}-${context.month} context.`,
    );
  }
  return {
    localDate: localDateOf(instant, context.timeZone),
    year: context.year,
    month: context.month,
    timeZone: context.timeZone,
  };
}
