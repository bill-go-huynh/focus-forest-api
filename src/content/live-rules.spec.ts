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
  liveBodyProblems(mode, body).problems;

describe('live body checks', () => {
  it('accepts a complete theme and trims its text', () => {
    const { problems: found, values } = liveBodyProblems('create', {
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
});

describe('locked fields', () => {
  const current = { endsAt: '2027-03-01T00:00:00.000Z' };
  const always = () => true;

  it('keeps what people took part in, and lets copy and status change', () => {
    expect(
      lockedProblems(current, { rewards: [], hemisphere: 'south', status: 'retired' }, always),
    ).toEqual([
      'rewards is locked: the theme has started.',
      'hemisphere is locked: the theme has started.',
    ]);
    // An unchanged value is not a change.
    expect(lockedProblems(current, { rewards: [] }, () => false)).toEqual([]);
  });

  it('moves the end only later', () => {
    expect(lockedProblems(current, { endsAt: '2027-02-28T00:00:00.000Z' }, always)).toEqual([
      'endsAt can only move later: the theme has started.',
    ]);
    expect(lockedProblems(current, { endsAt: '2027-03-01T00:00:00.000Z' }, always)).toEqual([]);
    expect(lockedProblems(current, { endsAt: '2027-03-05T00:00:00.000Z' }, always)).toEqual([]);
  });
});
