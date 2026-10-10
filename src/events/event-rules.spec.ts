import { eventPhase, missionValue, reachedMilestones, type MissionInput } from './event-rules.js';

const input = (over: Partial<MissionInput> = {}): MissionInput => ({
  days: [
    { date: '2026-10-12', minutes: 45, sessions: 2 },
    { date: '2026-10-13', minutes: 10, sessions: 1 },
    { date: '2026-10-14', minutes: 30, sessions: 1 },
  ],
  togetherSessions: 2,
  longestStreak: 3,
  ...over,
});

describe('event rules (A5.6)', () => {
  it('derives each mission from the normal focus in the event window', () => {
    expect(missionValue({ measure: 'focus_minutes', dailyMinutes: 0 }, input())).toBe(85);
    expect(missionValue({ measure: 'sessions', dailyMinutes: 0 }, input())).toBe(4);
    expect(missionValue({ measure: 'active_days', dailyMinutes: 0 }, input())).toBe(3);
    expect(missionValue({ measure: 'active_days', dailyMinutes: 30 }, input())).toBe(2);
    expect(missionValue({ measure: 'streak_days', dailyMinutes: 0 }, input())).toBe(3);
    expect(missionValue({ measure: 'focus_together_sessions', dailyMinutes: 0 }, input())).toBe(2);
  });

  it('reaches every milestone whose number of completed missions is met', () => {
    const milestones = [
      { id: 'first', requiredMissions: 1 },
      { id: 'half', requiredMissions: 2 },
      { id: 'all', requiredMissions: 3 },
    ];
    expect(reachedMilestones(milestones, 0)).toEqual([]);
    expect(reachedMilestones(milestones, 2)).toEqual(['first', 'half']);
    expect(reachedMilestones(milestones, 3)).toEqual(['first', 'half', 'all']);
  });

  it('is upcoming, live in [startsAt, endsAt), then ended', () => {
    const event = {
      startsAt: new Date('2026-10-15T00:00:00Z'),
      endsAt: new Date('2026-10-22T00:00:00Z'),
    };
    expect(eventPhase(event, new Date('2026-10-14T23:59:59Z'))).toBe('upcoming');
    expect(eventPhase(event, new Date('2026-10-15T00:00:00Z'))).toBe('live');
    expect(eventPhase(event, new Date('2026-10-21T23:59:59Z'))).toBe('live');
    expect(eventPhase(event, new Date('2026-10-22T00:00:00Z'))).toBe('ended');
  });
});
