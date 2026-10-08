/**
 * Why a stored session counted or not (docs/09 → Session diagnostics: debug "my session didn't
 * count"), explained from its stored values and the rules of the configuration version it was
 * evaluated with. Pure. Submissions refused with 400 (invalid times) are not stored, so they are
 * not here.
 */

export interface StoredSessionFacts {
  status: 'completed' | 'ended_early' | 'discarded';
  plannedMinutes: number;
  focusedMilliseconds: number;
  pausedMilliseconds: number;
  submittedEndedAt: Date;
  effectiveEndedAt: Date;
}

export interface SessionRulesAt {
  version: number;
  minValidMinutes: number;
  maxPauseMinutes: number;
}

export type SessionOutcome = 'completed' | 'below_minimum' | 'pause_limit' | 'ended_early';

export interface SessionExplanation {
  outcome: SessionOutcome;
  counted: boolean;
  text: string;
}

const minutes = (ms: number) => Math.floor(ms / 60_000);

export function explainSession(
  session: StoredSessionFacts,
  rules: SessionRulesAt,
): SessionExplanation {
  const at = `(configuration v${rules.version})`;
  if (session.status === 'discarded') {
    return {
      outcome: 'below_minimum',
      counted: false,
      text: `Not counted: ${minutes(session.focusedMilliseconds)} min of focus, under the ${rules.minValidMinutes}-minute minimum ${at}.`,
    };
  }
  if (session.status === 'completed') {
    return {
      outcome: 'completed',
      counted: true,
      text: `Counted: completed the planned ${session.plannedMinutes} min.`,
    };
  }
  const endedByPause =
    session.effectiveEndedAt < session.submittedEndedAt &&
    session.pausedMilliseconds >= rules.maxPauseMinutes * 60_000;
  return endedByPause
    ? {
        outcome: 'pause_limit',
        counted: true,
        text: `Counted: ended automatically when pauses reached ${rules.maxPauseMinutes} min ${at}, after ${minutes(session.focusedMilliseconds)} min of focus.`,
      }
    : {
        outcome: 'ended_early',
        counted: true,
        text: `Counted: ended early after ${minutes(session.focusedMilliseconds)} of the planned ${session.plannedMinutes} min.`,
      };
}
