import type { DayFocus } from '../challenges/challenge-rules.js';

/**
 * A5.6 Events (spec §11, docs/02 Events, docs/06 Event, EventMission). Pure. Missions count the
 * focus the user would do anyway: their counted sessions that started inside the event window.
 * There is no event-only focus and nothing to grind.
 */

export type MissionMeasure =
  'focus_minutes' | 'sessions' | 'active_days' | 'streak_days' | 'focus_together_sessions';

export interface MissionInput {
  /** Counted focus per local date, from sessions that started in the window: only days with one. */
  days: readonly DayFocus[];
  /** Completed Focus Together places whose session started in the window. */
  togetherSessions: number;
  /** The longest streak reached on any local date of the window. */
  longestStreak: number;
}

export function missionValue(
  mission: { measure: MissionMeasure; dailyMinutes: number },
  input: MissionInput,
): number {
  switch (mission.measure) {
    case 'focus_minutes':
      return input.days.reduce((sum, day) => sum + day.minutes, 0);
    case 'sessions':
      return input.days.reduce((sum, day) => sum + day.sessions, 0);
    case 'active_days':
      // Every listed day has a counted session, so it is active; a daily amount can ask for more.
      return input.days.filter((day) => day.minutes >= mission.dailyMinutes).length;
    case 'streak_days':
      return input.longestStreak;
    case 'focus_together_sessions':
      return input.togetherSessions;
  }
}

/** Milestones reached with this many completed missions, in the given order. */
export function reachedMilestones(
  milestones: readonly { id: string; requiredMissions: number }[],
  completedMissions: number,
): string[] {
  return milestones.filter((m) => completedMissions >= m.requiredMissions).map((m) => m.id);
}

export type EventPhase = 'upcoming' | 'live' | 'ended';

export function eventPhase(event: { startsAt: Date; endsAt: Date }, now: Date): EventPhase {
  if (now < event.startsAt) return 'upcoming';
  return now < event.endsAt ? 'live' : 'ended';
}
