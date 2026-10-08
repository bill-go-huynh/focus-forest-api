import { explainSession, type StoredSessionFacts } from './session-diagnostics.js';

const RULES = { version: 4, minValidMinutes: 5, maxPauseMinutes: 30 };
const base: StoredSessionFacts = {
  status: 'completed',
  plannedMinutes: 25,
  focusedMilliseconds: 25 * 60_000,
  pausedMilliseconds: 0,
  submittedEndedAt: new Date('2026-10-08T10:25:00.000Z'),
  effectiveEndedAt: new Date('2026-10-08T10:25:00.000Z'),
};

describe('session diagnostics (CR.4)', () => {
  it('explains each outcome from the stored values and its version’s rules', () => {
    expect(explainSession(base, RULES)).toEqual({
      outcome: 'completed',
      counted: true,
      text: 'Counted: completed the planned 25 min.',
    });
    expect(
      explainSession({ ...base, status: 'discarded', focusedMilliseconds: 4.9 * 60_000 }, RULES),
    ).toEqual({
      outcome: 'below_minimum',
      counted: false,
      text: 'Not counted: 4 min of focus, under the 5-minute minimum (configuration v4).',
    });
    expect(
      explainSession(
        {
          ...base,
          status: 'ended_early',
          focusedMilliseconds: 12 * 60_000,
          pausedMilliseconds: 30 * 60_000,
          submittedEndedAt: new Date('2026-10-08T11:30:00.000Z'),
          effectiveEndedAt: new Date('2026-10-08T10:42:00.000Z'),
        },
        RULES,
      ),
    ).toMatchObject({ outcome: 'pause_limit', counted: true });
    expect(
      explainSession({ ...base, status: 'ended_early', focusedMilliseconds: 12 * 60_000 }, RULES),
    ).toEqual({
      outcome: 'ended_early',
      counted: true,
      text: 'Counted: ended early after 12 of the planned 25 min.',
    });
  });
});
