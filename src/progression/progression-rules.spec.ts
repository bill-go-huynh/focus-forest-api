import {
  ACHIEVEMENT_CRITERIA,
  acquirableAt,
  criterionUnit,
  isContentId,
  type Acquisition,
} from './progression-rules.js';

const at = new Date('2026-10-10T12:00:00.000Z');

const definition = (overrides: Partial<Acquisition> = {}): Acquisition => ({
  status: 'active',
  source: 'achievement',
  availability: 'permanent',
  availableFrom: null,
  availableUntil: null,
  ...overrides,
});

describe('acquirableAt: whether content can be acquired now (never whether it stays owned)', () => {
  it('allows active, permanent content from a source whose system exists', () => {
    expect(acquirableAt(definition(), at)).toEqual({ acquirable: true });
    expect(acquirableAt(definition({ source: 'system' }), at)).toEqual({ acquirable: true });
  });

  it('refuses planned and retired content', () => {
    expect(acquirableAt(definition({ status: 'planned' }), at)).toEqual({
      acquirable: false,
      reason: 'not_active',
    });
    expect(acquirableAt(definition({ status: 'retired' }), at)).toEqual({
      acquirable: false,
      reason: 'not_active',
    });
  });

  it('opens limited content inside its window only (the end is exclusive)', () => {
    const limited = definition({
      availability: 'limited',
      availableFrom: new Date('2026-10-01T00:00:00.000Z'),
      availableUntil: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(acquirableAt(limited, at)).toEqual({ acquirable: true });
    expect(acquirableAt(limited, new Date('2026-09-30T23:59:59.999Z'))).toEqual({
      acquirable: false,
      reason: 'not_started',
    });
    expect(acquirableAt(limited, new Date('2026-11-01T00:00:00.000Z'))).toEqual({
      acquirable: false,
      reason: 'ended',
    });
  });

  it('opens season content from A5.9, within its window', () => {
    expect(acquirableAt(definition({ source: 'season' }), at)).toEqual({ acquirable: true });
  });
});

describe('content identifiers', () => {
  it('are lowercase slugs with an optional parameter, like trait and area ids', () => {
    for (const id of ['signature', 'first-session', 'focus-hours:10', 'focus-streak:100', 'lake']) {
      expect(isContentId(id)).toBe(true);
    }
  });

  it('refuse display names, dots, spaces, and capitals', () => {
    for (const id of ['', 'Focus Hours', 'badge.first_session', 'Oak', 'a:b:c', 'x-', ':10']) {
      expect(isContentId(id)).toBe(false);
    }
  });
});

describe('achievement criteria', () => {
  it('are a closed set, each with one unit', () => {
    expect(ACHIEVEMENT_CRITERIA).toEqual([
      'counted_sessions',
      'focused_minutes',
      'longest_streak_days',
      'focus_together_sessions',
      'focus_together_with_friend',
      'sessions_before_7',
      'sessions_after_22',
      'full_weekends',
    ]);
    expect(ACHIEVEMENT_CRITERIA.map(criterionUnit)).toEqual([
      'sessions',
      'minutes',
      'days',
      'sessions',
      'sessions',
      'sessions',
      'sessions',
      'weekends',
    ]);
  });
});
