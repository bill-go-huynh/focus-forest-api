import { liveBodyProblems, lockedProblems } from './live-rules.js';

const THEME = {
  id: 'winter-north',
  name: 'Winter',
  description: 'Snow settles softly.',
  environmentId: 'winter',
  hemisphere: 'north',
  status: 'active',
  startsAt: '2026-12-01T00:00:00.000Z',
  endsAt: '2027-03-01T00:00:00.000Z',
  rewards: [{ id: 'ten-days', badgeId: 'season:winter', requiredActiveDays: 10 }],
  reason: 'Winter theme',
};

const problems = (body: Record<string, unknown>, mode: 'create' | 'update' = 'create') =>
  liveBodyProblems('theme', mode, body).problems;

describe('live body checks', () => {
  it('accepts a complete theme and trims its text', () => {
    const { problems: found, values } = liveBodyProblems('theme', 'create', {
      ...THEME,
      name: ' Winter ',
    });
    expect(found).toEqual([]);
    expect(values['name']).toBe('Winter');
    expect(values).not.toHaveProperty('reason');
  });

  it('names the field of every problem, nested ones included', () => {
    expect(
      problems({ ...THEME, rewards: [{ id: 'a', badgeId: 'b', requiredActiveDays: 1.5 }] }),
    ).toEqual(['rewards[0].requiredActiveDays must be a whole number from 0 to 366.']);
    expect(problems({ ...THEME, rewards: [{ id: 'a', badgeId: 'b' }] })).toEqual([
      'rewards[0].requiredActiveDays is required.',
    ]);
    expect(
      problems({
        ...THEME,
        rewards: [{ id: 'a', badgeId: 'b', requiredActiveDays: 1, gift: true }],
      }),
    ).toEqual(['rewards[0].gift is not a field.']);
    expect(problems({ ...THEME, rewards: 'none' })).toEqual([
      'rewards must be a list of at most 10.',
    ]);
    expect(problems({ ...THEME, rewards: [1] })).toEqual(['rewards[0] must be an object.']);
    expect(problems({ ...THEME, hemisphere: 'east' })[0]).toContain('hemisphere must be one of');
    expect(problems({ ...THEME, hemisphere: null })).toEqual([]);
    expect(problems({ ...THEME, startsAt: '2026-12-01' })).toEqual([
      'startsAt must be an ISO 8601 UTC instant.',
    ]);
    expect(problems({ ...THEME, name: '' })).toEqual(['name must be text of 1 to 60 characters.']);
    expect(problems({ ...THEME, environmentId: '' })).toEqual(['environmentId must be text.']);
    expect(problems({ ...THEME, mood: 'calm' })).toEqual(['mood is not a field of a theme.']);
  });

  it('needs every field to create, a reason always, and something to change', () => {
    const rest: Record<string, unknown> = { ...THEME };
    delete rest['rewards'];
    expect(problems(rest)).toEqual(['rewards is required.']);
    expect(problems({ ...THEME, reason: 'no' })).toEqual([
      'reason must say why, in 3 to 500 characters.',
    ]);
    expect(problems({ reason: 'Nothing' }, 'update')).toEqual(['Change at least one field.']);
    expect(problems({ id: 'other', reason: 'Rename' }, 'update')).toEqual([
      'id cannot be changed once created.',
    ]);
    expect(problems({ name: 'Deep winter', reason: 'Copy' }, 'update')).toEqual([]);
  });

  it('checks event bodies with their nested missions and Community Tree', () => {
    const event = {
      id: 'sprint',
      name: 'Sprint',
      description: 'A week.',
      artworkId: 'sprint',
      status: 'active',
      startsAt: '2026-12-01T00:00:00.000Z',
      endsAt: '2026-12-08T00:00:00.000Z',
      entryMinSessions: 0,
      leaderboard: false,
      teams: [],
      missions: [
        {
          id: 'hour',
          measure: 'focus_minutes',
          target: 60,
          dailyMinutes: 0,
          name: 'An hour',
          description: 'One hour.',
        },
      ],
      milestones: [{ id: 'one', name: 'One', requiredMissions: 1, badgeId: null, trait: true }],
      communityTree: null,
      reason: 'Sprint',
    };
    expect(liveBodyProblems('event', 'create', event).problems).toEqual([]);
    expect(
      liveBodyProblems('event', 'create', {
        ...event,
        missions: [{ ...event.missions[0], measure: 'pages' }],
      }).problems[0],
    ).toContain('missions[0].measure must be one of');
    expect(
      liveBodyProblems('event', 'create', {
        ...event,
        communityTree: {
          name: 'Oak',
          artworkId: 'oak',
          milestones: [{ stage: 'huge', thresholdMinutes: 1, badgeId: 'b' }],
        },
      }).problems[0],
    ).toContain('communityTree.milestones[0].stage');
    expect(liveBodyProblems('event', 'create', { ...event, leaderboard: 'yes' }).problems).toEqual([
      'leaderboard must be true or false.',
    ]);
  });
});

describe('locked fields', () => {
  const current = { endsAt: '2027-03-01T00:00:00.000Z' };
  const always = () => true;

  it('keeps what people took part in, and lets copy and status change', () => {
    expect(
      lockedProblems('event', current, { missions: [], startsAt: 'x', name: 'New' }, always),
    ).toEqual([
      'missions is locked: people have taken part.',
      'startsAt is locked: people have taken part.',
    ]);
    expect(
      lockedProblems(
        'theme',
        current,
        { rewards: [], hemisphere: 'south', status: 'retired' },
        always,
      ),
    ).toEqual([
      'rewards is locked: the theme has started.',
      'hemisphere is locked: the theme has started.',
    ]);
    // An unchanged value is not a change.
    expect(lockedProblems('event', current, { missions: [] }, () => false)).toEqual([]);
  });

  it('moves the end only later', () => {
    expect(
      lockedProblems('event', current, { endsAt: '2027-02-28T00:00:00.000Z' }, always),
    ).toEqual(['endsAt can only move later: people have taken part.']);
    expect(
      lockedProblems('event', current, { endsAt: '2027-03-01T00:00:00.000Z' }, always),
    ).toEqual([]);
    expect(
      lockedProblems('theme', current, { endsAt: '2027-03-05T00:00:00.000Z' }, always),
    ).toEqual([]);
  });
});
