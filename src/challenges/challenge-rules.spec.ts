import {
  challengePhase,
  challengeReached,
  participantValue,
  windowEnd,
  type DayFocus,
} from './challenge-rules.js';

const day = (date: string, minutes: number, sessions = 1): DayFocus => ({
  date,
  minutes,
  sessions,
});

describe('challenge rules (A5.5)', () => {
  describe('participantValue: derived only from counted focus in the window', () => {
    const days = [day('2026-10-10', 45, 2), day('2026-10-11', 20), day('2026-10-12', 30, 3)];

    it('counts focused minutes', () => {
      expect(participantValue({ measure: 'focus_minutes', dailyMinutes: 0 }, days)).toBe(95);
    });

    it('counts counted sessions', () => {
      expect(participantValue({ measure: 'sessions', dailyMinutes: 0 }, days)).toBe(6);
    });

    it('counts days with at least the daily amount', () => {
      expect(participantValue({ measure: 'active_days', dailyMinutes: 30 }, days)).toBe(2);
      expect(participantValue({ measure: 'active_days', dailyMinutes: 15 }, days)).toBe(3);
      expect(participantValue({ measure: 'active_days', dailyMinutes: 30 }, [])).toBe(0);
    });
  });

  describe('challengeReached', () => {
    it('needs every participant at the target for an "each" goal', () => {
      expect(challengeReached('each', 600, [600, 700])).toBe(true);
      expect(challengeReached('each', 600, [600, 599])).toBe(false);
      expect(challengeReached('each', 600, [])).toBe(false);
    });

    it('adds everyone up for a shared goal', () => {
      expect(challengeReached('shared', 3000, [1000, 1500, 500])).toBe(true);
      expect(challengeReached('shared', 3000, [1000, 1999])).toBe(false);
    });
  });

  describe('challengePhase', () => {
    const window = { startDate: '2026-10-10', endDate: '2026-10-16' };
    it('is upcoming, active, then ended; completed whenever reached', () => {
      expect(challengePhase('2026-10-09', window, false)).toBe('upcoming');
      expect(challengePhase('2026-10-10', window, false)).toBe('active');
      expect(challengePhase('2026-10-16', window, false)).toBe('active');
      expect(challengePhase('2026-10-17', window, false)).toBe('ended');
      expect(challengePhase('2026-10-12', window, true)).toBe('completed');
      expect(challengePhase('2026-10-30', window, true)).toBe('completed');
    });
  });

  it('runs for its number of local days, the start included', () => {
    expect(windowEnd('2026-10-10', 7)).toBe('2026-10-16');
    expect(windowEnd('2026-10-28', 7)).toBe('2026-11-03');
    expect(windowEnd('2026-10-10', 1)).toBe('2026-10-10');
  });
});
