import { compareLocalDates, weekStartOf, type LocalDate } from '../common/local-date.js';
import type { FocusSessionStatus } from '../generated/prisma/client.js';

/**
 * Focus statistics derived from counted focus sessions (docs/06_DOMAIN_MODEL.md: FocusSession is
 * the source event). Days are the sessions' stored local dates, never recomputed from start
 * times. Weeks run Monday to Sunday.
 */

/** Completed and ended-early sessions count. Discarded sessions stay in history but count for nothing. */
export function isCounted(status: FocusSessionStatus): boolean {
  return status !== 'discarded';
}

export interface StatsSession {
  localDate: LocalDate;
  focusedMilliseconds: number;
  status: FocusSessionStatus;
  topicId: string;
}

/** Counted focus on one local date. */
export interface DayFocus {
  date: LocalDate;
  focusedMilliseconds: number;
  sessionCount: number;
}

export interface WeekFocus {
  /** The Monday. */
  weekStart: LocalDate;
  focusedMilliseconds: number;
  sessionCount: number;
  activeDays: number;
}

export interface TopicFocus {
  topicId: string;
  focusedMilliseconds: number;
  sessionCount: number;
}

export interface DaysSummary {
  focusedMilliseconds: number;
  sessionCount: number;
  /** Days with at least one counted session, in date order. */
  days: DayFocus[];
  activeDates: LocalDate[];
  weeks: WeekFocus[];
}

export interface FocusSummary extends DaysSummary {
  longestSessionMilliseconds: number;
  /** Largest first. */
  topics: TopicFocus[];
}

/** Totals, weeks, and active dates from per-day totals (for example, from the database). */
export function summarizeDays(input: readonly DayFocus[]): DaysSummary {
  const days = input
    .filter((day) => day.sessionCount > 0)
    .map((day) => ({ ...day }))
    .sort((a, b) => compareLocalDates(a.date, b.date));

  const weeks = new Map<LocalDate, WeekFocus>();
  for (const day of days) {
    const weekStart = weekStartOf(day.date);
    const week = weeks.get(weekStart) ?? {
      weekStart,
      focusedMilliseconds: 0,
      sessionCount: 0,
      activeDays: 0,
    };
    week.focusedMilliseconds += day.focusedMilliseconds;
    week.sessionCount += day.sessionCount;
    week.activeDays += 1;
    weeks.set(weekStart, week);
  }

  return {
    focusedMilliseconds: days.reduce((sum, day) => sum + day.focusedMilliseconds, 0),
    sessionCount: days.reduce((sum, day) => sum + day.sessionCount, 0),
    days,
    activeDates: days.map((day) => day.date),
    weeks: [...weeks.values()],
  };
}

export function summarizeFocus(sessions: readonly StatsSession[]): FocusSummary {
  const counted = sessions.filter((session) => isCounted(session.status));

  const days = new Map<LocalDate, DayFocus>();
  const topics = new Map<string, TopicFocus>();
  let longestSessionMilliseconds = 0;
  for (const session of counted) {
    const day = days.get(session.localDate) ?? {
      date: session.localDate,
      focusedMilliseconds: 0,
      sessionCount: 0,
    };
    day.focusedMilliseconds += session.focusedMilliseconds;
    day.sessionCount += 1;
    days.set(session.localDate, day);

    const topic = topics.get(session.topicId) ?? {
      topicId: session.topicId,
      focusedMilliseconds: 0,
      sessionCount: 0,
    };
    topic.focusedMilliseconds += session.focusedMilliseconds;
    topic.sessionCount += 1;
    topics.set(session.topicId, topic);

    longestSessionMilliseconds = Math.max(longestSessionMilliseconds, session.focusedMilliseconds);
  }

  return {
    ...summarizeDays([...days.values()]),
    longestSessionMilliseconds,
    topics: sortTopics([...topics.values()]),
  };
}

/** Largest first; ties by id, so the order never depends on input order. */
export function sortTopics(topics: TopicFocus[]): TopicFocus[] {
  return topics.sort(
    (a, b) =>
      b.focusedMilliseconds - a.focusedMilliseconds ||
      (a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0),
  );
}
