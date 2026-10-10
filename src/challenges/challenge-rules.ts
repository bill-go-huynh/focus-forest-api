import { addDays, type LocalDate } from '../common/local-date.js';

/**
 * A5.5 Challenges (spec §15, docs/02 Challenges, docs/06 Challenge). Pure. Progress is derived
 * only from each participant's counted sessions on the local dates of the challenge window: no
 * counters, nothing for opening the app or tapping.
 */

export type ChallengeKind = 'personal' | 'friend' | 'group';
export type ChallengeMeasure = 'focus_minutes' | 'sessions' | 'active_days';
/** Every participant reaches the target, or everyone's progress adds up to it. No races. */
export type ChallengeGoal = 'each' | 'shared';

export interface ChallengeTemplate {
  id: string;
  kind: ChallengeKind;
  measure: ChallengeMeasure;
  goal: ChallengeGoal;
  target: number;
  /** For `active_days`: the counted minutes a day needs. 0 otherwise. */
  dailyMinutes: number;
  /** The window in local days, the start included. */
  days: number;
  maxParticipants: number;
}

/** One participant's counted focus on one local date in the window. */
export interface DayFocus {
  date: LocalDate;
  minutes: number;
  sessions: number;
}

export function participantValue(
  rule: { measure: ChallengeMeasure; dailyMinutes: number },
  days: readonly DayFocus[],
): number {
  switch (rule.measure) {
    case 'focus_minutes':
      return days.reduce((sum, day) => sum + day.minutes, 0);
    case 'sessions':
      return days.reduce((sum, day) => sum + day.sessions, 0);
    case 'active_days':
      return days.filter((day) => day.minutes >= rule.dailyMinutes).length;
  }
}

export function challengeReached(goal: ChallengeGoal, target: number, values: readonly number[]) {
  if (values.length === 0) return false;
  return goal === 'shared'
    ? values.reduce((sum, value) => sum + value, 0) >= target
    : values.every((value) => value >= target);
}

export type ChallengePhase = 'upcoming' | 'active' | 'completed' | 'ended';

/**
 * Completed once reached (and it stays so); otherwise ended after the window, with no penalty: it
 * simply ends (docs/02).
 */
export function challengePhase(
  today: LocalDate,
  window: { startDate: LocalDate; endDate: LocalDate },
  completed: boolean,
): ChallengePhase {
  if (completed) return 'completed';
  if (today < window.startDate) return 'upcoming';
  return today > window.endDate ? 'ended' : 'active';
}

export function windowEnd(startDate: LocalDate, days: number): LocalDate {
  return addDays(startDate, days - 1);
}

/** Whether a template list is coherent: one id each, and fields that fit the kind and measure. */
export function templateProblem(templates: readonly ChallengeTemplate[]): string | null {
  if (templates.length === 0) return 'at least one template';
  if (new Set(templates.map((t) => t.id)).size !== templates.length) return 'unique ids';
  for (const t of templates) {
    if (t.kind === 'personal' && (t.maxParticipants !== 1 || t.goal !== 'each')) {
      return 'personal templates for one person with an "each" goal';
    }
    if (t.kind !== 'personal' && t.maxParticipants < 2) return 'shared templates for 2 or more';
    if (t.measure === 'active_days' && (t.dailyMinutes < 1 || t.target > t.days)) {
      return 'active-day templates with a daily amount and at most one day per window day';
    }
    if (t.measure !== 'active_days' && t.dailyMinutes !== 0) {
      return 'a daily amount only for active-day templates';
    }
  }
  return null;
}
