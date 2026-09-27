import { evaluateSession, type SessionSubmission, type SessionRules } from './evaluate-session.js';

const MINUTE = 60_000;
const DAY = '2026-09-27';
/** "10:30" → that time on a fixed day, in UTC. "10:30:00.001" for millisecond precision. */
const t = (time: string) => new Date(`${DAY}T${time.length === 5 ? `${time}:00` : time}Z`);
const NOW = t('12:00');
const RULES: SessionRules = { minValidMinutes: 5, maxPauseMinutes: 30 };

function submission(overrides: Partial<SessionSubmission> = {}): SessionSubmission {
  return {
    startedAt: t('10:00'),
    endedAt: t('10:25'),
    plannedMinutes: 25,
    pauses: [],
    ...overrides,
  };
}

const pause = (start: string, end: string) => ({ startedAt: t(start), endedAt: t(end) });

function accepted(input: SessionSubmission, rules = RULES, now = NOW) {
  const result = evaluateSession(input, rules, now);
  if (result.kind !== 'accepted') throw new Error(`expected accepted, got ${result.reason}`);
  return result;
}

function rejection(input: SessionSubmission, rules = RULES, now = NOW) {
  const result = evaluateSession(input, rules, now);
  if (result.kind !== 'rejected') throw new Error('expected a rejection');
  return result.reason;
}

describe('evaluateSession', () => {
  describe('without pauses', () => {
    it('completes when the planned duration is reached', () => {
      expect(accepted(submission())).toEqual({
        kind: 'accepted',
        effectiveEnd: t('10:25'),
        focusedMilliseconds: 25 * MINUTE,
        pausedMilliseconds: 0,
        status: 'completed',
        counted: true,
      });
    });

    it('ends early and counts above the minimum', () => {
      expect(accepted(submission({ endedAt: t('10:12') }))).toMatchObject({
        effectiveEnd: t('10:12'),
        focusedMilliseconds: 12 * MINUTE,
        status: 'ended_early',
        counted: true,
      });
    });

    it('counts at exactly the minimum', () => {
      expect(accepted(submission({ endedAt: t('10:05') }))).toMatchObject({
        focusedMilliseconds: 5 * MINUTE,
        status: 'ended_early',
        counted: true,
      });
    });

    it('discards 1 ms below the minimum', () => {
      expect(accepted(submission({ endedAt: t('10:04:59.999') }))).toMatchObject({
        focusedMilliseconds: 5 * MINUTE - 1,
        status: 'discarded',
        counted: false,
      });
    });

    it('discards a session ended the moment it started', () => {
      expect(accepted(submission({ endedAt: t('10:00') }))).toMatchObject({
        focusedMilliseconds: 0,
        status: 'discarded',
        counted: false,
      });
    });

    it('discards a completed session whose planned duration is below the minimum', () => {
      expect(accepted(submission({ plannedMinutes: 3, endedAt: t('10:03') }))).toMatchObject({
        effectiveEnd: t('10:03'),
        focusedMilliseconds: 3 * MINUTE,
        status: 'discarded',
        counted: false,
      });
    });
  });

  describe('pauses', () => {
    it('excludes a pause from focused time', () => {
      expect(
        accepted(submission({ endedAt: t('10:20'), pauses: [pause('10:05', '10:10')] })),
      ).toMatchObject({
        focusedMilliseconds: 15 * MINUTE,
        pausedMilliseconds: 5 * MINUTE,
        status: 'ended_early',
      });
    });

    it('excludes several pauses', () => {
      const result = accepted(
        submission({
          endedAt: t('10:30'),
          pauses: [pause('10:02', '10:04'), pause('10:10', '10:13'), pause('10:20', '10:21')],
        }),
      );
      expect(result).toMatchObject({
        focusedMilliseconds: 24 * MINUTE,
        pausedMilliseconds: 6 * MINUTE,
      });
    });

    it('accepts adjacent half-open pauses as not overlapping', () => {
      const result = accepted(
        submission({
          endedAt: t('10:20'),
          pauses: [pause('10:05', '10:08'), pause('10:08', '10:10')],
        }),
      );
      expect(result).toMatchObject({
        focusedMilliseconds: 15 * MINUTE,
        pausedMilliseconds: 5 * MINUTE,
      });
    });

    it('accepts a zero-length pause as an empty interval', () => {
      const result = accepted(
        submission({ endedAt: t('10:20'), pauses: [pause('10:05', '10:05')] }),
      );
      expect(result).toMatchObject({ focusedMilliseconds: 20 * MINUTE, pausedMilliseconds: 0 });
    });

    it('accepts a pause from the very start', () => {
      const result = accepted(
        submission({ endedAt: t('10:20'), pauses: [pause('10:00', '10:05')] }),
      );
      expect(result).toMatchObject({
        focusedMilliseconds: 15 * MINUTE,
        pausedMilliseconds: 5 * MINUTE,
      });
    });
  });

  describe('the completion instant', () => {
    it('is pushed back by a pause before it', () => {
      // 10:00 + 25 min of focus, with 10:10–10:15 paused → 10:30.
      const result = accepted(
        submission({ endedAt: t('10:30'), pauses: [pause('10:10', '10:15')] }),
      );
      expect(result).toMatchObject({
        effectiveEnd: t('10:30'),
        focusedMilliseconds: 25 * MINUTE,
        pausedMilliseconds: 5 * MINUTE,
        status: 'completed',
      });
    });

    it('is pushed back by several pauses before it', () => {
      const result = accepted(
        submission({
          endedAt: t('11:00'),
          pauses: [pause('10:05', '10:07'), pause('10:15', '10:18')],
        }),
      );
      expect(result).toMatchObject({ effectiveEnd: t('10:30'), pausedMilliseconds: 5 * MINUTE });
    });

    it('clamps a later submitted end to the completion instant', () => {
      const result = accepted(submission({ endedAt: t('11:40') }));
      expect(result).toMatchObject({
        effectiveEnd: t('10:25'),
        focusedMilliseconds: 25 * MINUTE,
        status: 'completed',
      });
    });

    it('ignores pauses after completion, instead of adding every submitted pause', () => {
      // Naively 10:00 + 25 + (5 + 15) = 10:45. The second pause starts after completion at 10:30.
      const result = accepted(
        submission({
          endedAt: t('11:00'),
          pauses: [pause('10:10', '10:15'), pause('10:35', '10:50')],
        }),
      );
      expect(result).toMatchObject({
        effectiveEnd: t('10:30'),
        focusedMilliseconds: 25 * MINUTE,
        pausedMilliseconds: 5 * MINUTE,
        status: 'completed',
      });
    });

    it('ignores a pause that starts exactly at completion', () => {
      const result = accepted(
        submission({ endedAt: t('10:40'), pauses: [pause('10:25', '10:40')] }),
      );
      expect(result).toMatchObject({
        effectiveEnd: t('10:25'),
        pausedMilliseconds: 0,
        status: 'completed',
      });
    });

    it('counts a pause that spans the naive completion time only once', () => {
      // Focus 10:00–10:20 (20 min), pause 10:20–10:40, focus again → completes at 10:45.
      const result = accepted(
        submission({ endedAt: t('11:00'), pauses: [pause('10:20', '10:40')] }),
      );
      expect(result).toMatchObject({
        effectiveEnd: t('10:45'),
        focusedMilliseconds: 25 * MINUTE,
        pausedMilliseconds: 20 * MINUTE,
      });
    });
  });

  describe('the pause limit', () => {
    it('allows exactly the maximum total pause', () => {
      const result = accepted(
        submission({ endedAt: t('10:55'), pauses: [pause('10:05', '10:35')] }),
      );
      expect(result).toMatchObject({
        effectiveEnd: t('10:55'),
        pausedMilliseconds: 30 * MINUTE,
        status: 'completed',
      });
    });

    it('allows 1 ms below the maximum', () => {
      const result = accepted(
        submission({ endedAt: t('11:00'), pauses: [pause('10:05', '10:34:59.999')] }),
      );
      expect(result).toMatchObject({ pausedMilliseconds: 30 * MINUTE - 1, status: 'completed' });
    });

    it('ends the session at the instant one long pause reaches the maximum', () => {
      const result = accepted(
        submission({ plannedMinutes: 60, endedAt: t('11:00'), pauses: [pause('10:05', '11:00')] }),
      );
      expect(result).toMatchObject({
        effectiveEnd: t('10:35'),
        focusedMilliseconds: 5 * MINUTE,
        pausedMilliseconds: 30 * MINUTE,
        status: 'ended_early',
        counted: true,
      });
    });

    it('ends the session when pauses add up to the maximum', () => {
      // 10 min paused earlier, so the pause from 10:20 reaches the 30-minute total at 10:40.
      const result = accepted(
        submission({
          plannedMinutes: 60,
          endedAt: t('11:00'),
          pauses: [pause('10:05', '10:15'), pause('10:20', '11:00')],
        }),
      );
      expect(result).toMatchObject({
        effectiveEnd: t('10:40'),
        focusedMilliseconds: 10 * MINUTE,
        pausedMilliseconds: 30 * MINUTE,
        status: 'ended_early',
      });
    });

    it('ends at the limit before the planned completion would have been reached', () => {
      const result = accepted(
        submission({
          endedAt: t('11:30'),
          pauses: [pause('10:10', '10:45'), pause('10:50', '10:55')],
        }),
      );
      expect(result).toMatchObject({ effectiveEnd: t('10:40'), focusedMilliseconds: 10 * MINUTE });
    });

    it('discards a session the pause limit ends below the minimum', () => {
      const result = accepted(
        submission({ endedAt: t('11:00'), pauses: [pause('10:03', '11:00')] }),
      );
      expect(result).toMatchObject({
        effectiveEnd: t('10:33'),
        focusedMilliseconds: 3 * MINUTE,
        status: 'discarded',
        counted: false,
      });
    });

    it("uses the server's limit when the client allowed a longer pause", () => {
      const input = submission({
        plannedMinutes: 60,
        endedAt: t('11:30'),
        pauses: [pause('10:10', '10:35')],
      });
      expect(accepted(input, { ...RULES, maxPauseMinutes: 30 }).effectiveEnd).toEqual(t('11:25'));
      expect(accepted(input, { ...RULES, maxPauseMinutes: 20 })).toMatchObject({
        effectiveEnd: t('10:30'),
        pausedMilliseconds: 20 * MINUTE,
        status: 'ended_early',
      });
    });
  });

  it('ends while paused, with the pause closed at the end', () => {
    const result = accepted(submission({ endedAt: t('10:20'), pauses: [pause('10:12', '10:20')] }));
    expect(result).toMatchObject({
      effectiveEnd: t('10:20'),
      focusedMilliseconds: 12 * MINUTE,
      pausedMilliseconds: 8 * MINUTE,
      status: 'ended_early',
      counted: true,
    });
  });

  describe('rejections', () => {
    it('rejects an end before the start', () => {
      expect(rejection(submission({ endedAt: t('09:59:59.999') }))).toBe('ends_before_start');
    });

    it('accepts an end exactly 120 s after now, and rejects 1 ms later', () => {
      const now = t('10:10');
      expect(evaluateSession(submission({ endedAt: t('10:12') }), RULES, now).kind).toBe(
        'accepted',
      );
      expect(rejection(submission({ endedAt: t('10:12:00.001') }), RULES, now)).toBe(
        'ends_in_future',
      );
    });

    it.each([0, -1, 1441, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects %s planned minutes',
      (plannedMinutes) => {
        expect(rejection(submission({ plannedMinutes }))).toBe('invalid_planned_duration');
      },
    );

    it.each([1, 1440])('accepts %i planned minutes', (plannedMinutes) => {
      expect(evaluateSession(submission({ plannedMinutes }), RULES, NOW).kind).toBe('accepted');
    });

    it.each([
      ['start', { startedAt: new Date('not a date') }],
      ['end', { endedAt: new Date('not a date') }],
      ['pause start', { pauses: [{ startedAt: new Date('x'), endedAt: t('10:05') }] }],
      ['pause end', { pauses: [{ startedAt: t('10:05'), endedAt: new Date('x') }] }],
    ])('rejects an invalid %s time', (_field, overrides) => {
      expect(rejection(submission(overrides))).toBe('invalid_time');
    });

    it('rejects a pause that ends before it starts', () => {
      expect(rejection(submission({ pauses: [pause('10:10', '10:05')] }))).toBe(
        'pause_ends_before_start',
      );
    });

    it('rejects a pause that starts before the session', () => {
      expect(rejection(submission({ pauses: [pause('09:59', '10:05')] }))).toBe(
        'pause_outside_session',
      );
    });

    it('rejects a pause that ends after the submitted end', () => {
      expect(rejection(submission({ pauses: [pause('10:20', '10:26')] }))).toBe(
        'pause_outside_session',
      );
    });

    it('rejects overlapping pauses', () => {
      expect(
        rejection(submission({ pauses: [pause('10:05', '10:10'), pause('10:09', '10:12')] })),
      ).toBe('pauses_overlap');
    });

    it('rejects pauses that are not in chronological order', () => {
      expect(
        rejection(submission({ pauses: [pause('10:15', '10:16'), pause('10:05', '10:06')] })),
      ).toBe('pauses_out_of_order');
    });
  });

  describe('configuration', () => {
    it('counts against the configured minimum, not a fixed 5 minutes', () => {
      const input = submission({ endedAt: t('10:08') });
      expect(accepted(input, { ...RULES, minValidMinutes: 5 })).toMatchObject({ counted: true });
      expect(accepted(input, { ...RULES, minValidMinutes: 10 })).toMatchObject({
        status: 'discarded',
        counted: false,
      });
    });

    it('ends at the configured pause limit, not a fixed 30 minutes', () => {
      const input = submission({
        plannedMinutes: 60,
        endedAt: t('12:00'),
        pauses: [pause('10:10', '11:10')],
      });
      expect(accepted(input, { ...RULES, maxPauseMinutes: 30 }).effectiveEnd).toEqual(t('10:40'));
      expect(accepted(input, { ...RULES, maxPauseMinutes: 45 }).effectiveEnd).toEqual(t('10:55'));
    });
  });
});
