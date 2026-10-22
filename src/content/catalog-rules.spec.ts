import { bodyProblems, rowProblems } from './catalog-rules.js';

const COSMETIC = {
  id: 'lantern-row',
  type: 'decoration',
  rarity: 'common',
  source: 'season',
  achievementId: null,
  availability: 'permanent',
  availableFrom: null,
  availableUntil: null,
  status: 'active',
  name: 'Lantern Row',
  description: 'Lanterns along the path.',
  artworkId: 'lantern-row',
  sortOrder: 60,
  reason: 'Seasonal decoration',
};

const problemsOf = (body: Record<string, unknown>, mode: 'create' | 'update' = 'create') =>
  bodyProblems('cosmetics', mode, body).problems;

describe('catalog body checks', () => {
  it('accepts a complete new item and trims its text', () => {
    const { problems, values } = bodyProblems('cosmetics', 'create', {
      ...COSMETIC,
      name: '  Lantern Row  ',
    });
    expect(problems).toEqual([]);
    expect(values['name']).toBe('Lantern Row');
    expect(values).not.toHaveProperty('reason');
  });

  it('needs every field of a new item', () => {
    const rest: Record<string, unknown> = { ...COSMETIC };
    delete rest['artworkId'];
    expect(problemsOf(rest)).toEqual(['artworkId is required.']);
  });

  it('checks each field’s shape', () => {
    expect(problemsOf({ ...COSMETIC, id: 'Lantern' })).toEqual([
      'id must be lowercase words joined by "-", with an optional ":part".',
    ]);
    expect(problemsOf({ ...COSMETIC, id: 'season:lantern-row' })).toEqual([]);
    expect(problemsOf({ ...COSMETIC, type: 'hat' })[0]).toContain('type must be one of');
    // Events were removed (owner, 2026-10-22): no new event content.
    expect(problemsOf({ ...COSMETIC, source: 'event' })).toEqual([
      'source must be one of: achievement, season.',
    ]);
    expect(problemsOf({ ...COSMETIC, name: 'x'.repeat(61) })[0]).toContain('1 to 60');
    expect(problemsOf({ ...COSMETIC, name: 'x'.repeat(60) })).toEqual([]);
    expect(problemsOf({ ...COSMETIC, description: 'x'.repeat(281) })[0]).toContain('1 to 280');
    expect(problemsOf({ ...COSMETIC, artworkId: 'Lantern Row' })[0]).toContain('artworkId');
    expect(problemsOf({ ...COSMETIC, sortOrder: 1.5 })[0]).toContain('whole number');
    expect(problemsOf({ ...COSMETIC, sortOrder: -1 })[0]).toContain('0 to 100000');
    expect(problemsOf({ ...COSMETIC, sortOrder: 100_000 })).toEqual([]);
    expect(problemsOf({ ...COSMETIC, availableFrom: '2026-11-01' })[0]).toContain('ISO 8601');
    expect(problemsOf({ ...COSMETIC, availableFrom: '2026-11-01T00:00:00Z' })).toEqual([]);
    expect(problemsOf({ ...COSMETIC, achievementId: 7 })[0]).toContain('achievementId');
  });

  it('needs a reason', () => {
    expect(problemsOf({ ...COSMETIC, reason: 'ok' })[0]).toContain('reason');
    expect(problemsOf({ ...COSMETIC, reason: 'x'.repeat(501) })[0]).toContain('reason');
    expect(problemsOf({ ...COSMETIC, reason: 'yes' })).toEqual([]);
  });

  it('starts new content planned or active, from a non-system source', () => {
    expect(problemsOf({ ...COSMETIC, status: 'retired' })).toEqual([
      'status of new content is planned or active.',
    ]);
    expect(problemsOf({ ...COSMETIC, status: 'planned' })).toEqual([]);
    expect(problemsOf({ ...COSMETIC, source: 'system' })[0]).toContain('source must be one of');
  });

  it('edits only editable fields, and at least one', () => {
    expect(problemsOf({ name: 'Lanterns', reason: 'Copy' }, 'update')).toEqual([]);
    expect(problemsOf({ type: 'fauna', reason: 'Move' }, 'update')).toEqual([
      'type cannot be changed once created.',
    ]);
    expect(problemsOf({ reason: 'Nothing' }, 'update')).toEqual(['Change at least one field.']);
    expect(problemsOf({ status: 'retired', reason: 'Season over' }, 'update')).toEqual([]);
    expect(problemsOf({ shine: true, reason: 'New' }, 'update')).toEqual([
      'shine is not a field of cosmetics.',
    ]);
  });

  it('checks achievements’ own fields', () => {
    const achievement = {
      id: 'deep-diver',
      badgeId: 'deep-diver',
      criterion: 'counted_sessions',
      target: 20,
      progressVisible: true,
      reason: 'New achievement',
    };
    expect(bodyProblems('achievements', 'create', achievement).problems).toEqual([]);
    expect(
      bodyProblems('achievements', 'create', { ...achievement, target: 0 }).problems[0],
    ).toContain('1 to 1000000');
    expect(
      bodyProblems('achievements', 'create', { ...achievement, progressVisible: 'yes' }).problems,
    ).toEqual(['progressVisible must be true or false.']);
    expect(
      bodyProblems('achievements', 'update', { badgeId: 'other', reason: 'Move' }).problems,
    ).toEqual(['badgeId cannot be changed once created.']);
  });
});

describe('catalog row checks', () => {
  const row = (change: Record<string, unknown>) => ({ ...COSMETIC, ...change }) as never;

  it('needs an end for limited content, and none for permanent content', () => {
    expect(rowProblems('cosmetics', row({ availability: 'limited' }))).toEqual([
      'availableUntil is required for limited content.',
    ]);
    expect(rowProblems('cosmetics', row({ availableUntil: '2026-12-01T00:00:00.000Z' }))).toEqual([
      'availableUntil must be null for permanent content.',
    ]);
    expect(
      rowProblems(
        'cosmetics',
        row({ availability: 'limited', availableUntil: '2026-12-01T00:00:00.000Z' }),
      ),
    ).toEqual([]);
  });

  it('opens a window before it closes', () => {
    const window = (from: string) =>
      rowProblems(
        'cosmetics',
        row({
          availability: 'limited',
          availableFrom: from,
          availableUntil: '2026-12-01T00:00:00.000Z',
        }),
      );
    expect(window('2026-12-01T00:00:00.000Z')).toEqual([
      'availableFrom must be before availableUntil.',
    ]);
    expect(window('2026-11-30T23:59:59.000Z')).toEqual([]);
  });

  it('names the unlocking achievement exactly when the source is achievement', () => {
    const message =
      'achievementId names the unlocking achievement exactly when the source is achievement.';
    expect(rowProblems('cosmetics', row({ source: 'achievement' }))).toEqual([message]);
    expect(rowProblems('cosmetics', row({ achievementId: 'first-session' }))).toEqual([message]);
    expect(
      rowProblems('cosmetics', row({ source: 'achievement', achievementId: 'first-session' })),
    ).toEqual([]);
    expect(rowProblems('species', row({ source: 'achievement' }))).toEqual([message]);
    // Badges are earned by an achievement that names them, not the other way round.
    expect(rowProblems('badges', row({ source: 'achievement' }))).toEqual([]);
  });
});
