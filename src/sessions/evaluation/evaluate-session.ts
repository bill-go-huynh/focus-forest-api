/**
 * Pure evaluation of a submitted focus session (docs/06_DOMAIN_MODEL.md → FocusSession).
 * The client runs the timer; the server derives everything that counts from the raw times.
 * No clock, database, or configuration lookup here: the caller passes `now` and the rules.
 */

const MINUTE_MS = 60_000;
/** Technical bound on the planned duration, not Product configuration. */
export const PLANNED_MINUTES_MAX = 1440;
/** How far a submitted end may be ahead of the server clock (device clock skew). */
export const FUTURE_TOLERANCE_MS = 120_000;

/** A pause, half-open: [startedAt, endedAt). Adjacent pauses do not overlap. */
export interface PauseInterval {
  startedAt: Date;
  endedAt: Date;
}

/**
 * The raw submission. `endedAt` is the end the client believes is right: the planned
 * completion, the moment the user ended, or the moment the pause limit was reached.
 * A pause still open when the user ended must be closed at `endedAt`.
 */
export interface SessionSubmission {
  startedAt: Date;
  endedAt: Date;
  plannedMinutes: number;
  /** In chronological order, without overlaps. */
  pauses: readonly PauseInterval[];
}

/** The session rules from Product configuration. */
export interface SessionRules {
  minValidMinutes: number;
  maxPauseMinutes: number;
}

export type SessionStatus = 'completed' | 'ended_early' | 'discarded';

export type SessionRejectionReason =
  | 'invalid_time'
  | 'invalid_planned_duration'
  | 'ends_before_start'
  | 'ends_in_future'
  | 'pause_ends_before_start'
  | 'pause_outside_session'
  | 'pauses_out_of_order'
  | 'pauses_overlap';

export type SessionEvaluation =
  | {
      kind: 'accepted';
      /** Where the session really ended: completion, the pause limit, or the submitted end. */
      effectiveEnd: Date;
      focusedMilliseconds: number;
      /** Pause before the effective end. */
      pausedMilliseconds: number;
      /** `discarded` exactly when the focused time is below the minimum. */
      status: SessionStatus;
      counted: boolean;
    }
  | { kind: 'rejected'; reason: SessionRejectionReason };

export function evaluateSession(
  submission: SessionSubmission,
  rules: SessionRules,
  now: Date,
): SessionEvaluation {
  const reason = findRejection(submission, now);
  if (reason) return { kind: 'rejected', reason };

  const start = submission.startedAt.getTime();
  const end = submission.endedAt.getTime();
  const plannedMs = submission.plannedMinutes * MINUTE_MS;
  const maxPauseMs = rules.maxPauseMinutes * MINUTE_MS;

  // Walk the timeline in order, alternating focus and pause, and stop at whichever comes
  // first: the planned focus is reached (completion), the total pause passes the limit
  // (automatic end, at the instant the limit is reached), or the submitted end.
  let focused = 0;
  let paused = 0;
  let cursor = start;
  let effectiveEnd = end;
  let completed = false;

  const segments = [
    ...submission.pauses.map((pause) => ({
      focusUntil: pause.startedAt.getTime(),
      pauseUntil: pause.endedAt.getTime(),
    })),
    { focusUntil: end, pauseUntil: end },
  ];

  for (const { focusUntil, pauseUntil } of segments) {
    const focusLength = focusUntil - cursor;
    if (focused + focusLength >= plannedMs) {
      effectiveEnd = cursor + (plannedMs - focused);
      focused = plannedMs;
      completed = true;
      break;
    }
    focused += focusLength;

    const pauseLength = pauseUntil - focusUntil;
    if (paused + pauseLength > maxPauseMs) {
      effectiveEnd = focusUntil + (maxPauseMs - paused);
      paused = maxPauseMs;
      break;
    }
    paused += pauseLength;
    cursor = pauseUntil;
  }

  const counted = focused >= rules.minValidMinutes * MINUTE_MS;
  return {
    kind: 'accepted',
    effectiveEnd: new Date(effectiveEnd),
    focusedMilliseconds: focused,
    pausedMilliseconds: paused,
    status: !counted ? 'discarded' : completed ? 'completed' : 'ended_early',
    counted,
  };
}

function findRejection(submission: SessionSubmission, now: Date): SessionRejectionReason | null {
  const { startedAt, endedAt, plannedMinutes, pauses } = submission;
  const times = [startedAt, endedAt, ...pauses.flatMap((p) => [p.startedAt, p.endedAt])];
  if (times.some((time) => Number.isNaN(time.getTime()))) return 'invalid_time';

  if (
    !Number.isInteger(plannedMinutes) ||
    plannedMinutes < 1 ||
    plannedMinutes > PLANNED_MINUTES_MAX
  ) {
    return 'invalid_planned_duration';
  }
  if (endedAt < startedAt) return 'ends_before_start';
  if (endedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return 'ends_in_future';

  let previous: PauseInterval | null = null;
  for (const pause of pauses) {
    if (pause.endedAt < pause.startedAt) return 'pause_ends_before_start';
    if (pause.startedAt < startedAt || pause.endedAt > endedAt) return 'pause_outside_session';
    if (previous) {
      if (pause.startedAt < previous.startedAt) return 'pauses_out_of_order';
      if (pause.startedAt < previous.endedAt) return 'pauses_overlap';
    }
    previous = pause;
  }
  return null;
}
