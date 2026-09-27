import type { PauseInterval, SessionSubmission } from './evaluation/evaluate-session.js';

// An instant with an explicit offset: "2026-09-27T10:00:00.000Z" or "…T17:00:00+07:00".
// Without an offset the time would be read in the server's zone, so it is invalid.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A Date, or an invalid Date the evaluator rejects as `invalid_time`. */
export function parseInstant(value: string): Date {
  return INSTANT.test(value) ? new Date(value) : new Date(Number.NaN);
}

export interface CanonicalSubmission extends SessionSubmission {
  topicId: string;
}

export function canonicalSubmission(raw: {
  topicId: string;
  startedAt: string;
  endedAt: string;
  plannedMinutes: number;
  pauseIntervals: readonly { startedAt: string; endedAt: string }[];
}): CanonicalSubmission {
  return {
    topicId: raw.topicId.toLowerCase(),
    startedAt: parseInstant(raw.startedAt),
    endedAt: parseInstant(raw.endedAt),
    plannedMinutes: raw.plannedMinutes,
    pauses: raw.pauseIntervals.map((pause) => ({
      startedAt: parseInstant(pause.startedAt),
      endedAt: parseInstant(pause.endedAt),
    })),
  };
}

/**
 * Identifies a submission by its raw measured values, never by what was derived from them,
 * so a replay matches whatever the configuration is now. Equal instants written with
 * different offsets are the same submission.
 */
export function submissionKey(submission: CanonicalSubmission): string {
  const iso = (date: Date) => (Number.isNaN(date.getTime()) ? 'invalid' : date.toISOString());
  return JSON.stringify([
    submission.topicId,
    iso(submission.startedAt),
    iso(submission.endedAt),
    submission.plannedMinutes,
    submission.pauses.map((pause: PauseInterval) => [iso(pause.startedAt), iso(pause.endedAt)]),
  ]);
}
