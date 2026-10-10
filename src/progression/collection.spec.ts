import {
  availabilityOf,
  byCatalogOrder,
  isVisible,
  summarize,
  unlockOf,
  type CollectionDefinition,
} from './collection.js';
import { CONTENT_SOURCES } from './progression-rules.js';

const now = new Date('2026-10-10T12:00:00.000Z');

const item = (overrides: Partial<CollectionDefinition> = {}): CollectionDefinition => ({
  id: 'oak',
  sortOrder: 20,
  status: 'active',
  source: 'achievement',
  availability: 'permanent',
  availableFrom: null,
  availableUntil: null,
  ...overrides,
});

describe('collection visibility: owned forever, otherwise only what can be obtained now', () => {
  it('always shows an owned item, whatever its status or window', () => {
    for (const status of ['active', 'retired', 'planned'] as const) {
      expect(isVisible(item({ status }), { owned: true, reachable: false }, now)).toBe(true);
    }
    expect(
      isVisible(
        item({
          availability: 'limited',
          availableFrom: new Date('2026-01-01T00:00:00.000Z'),
          availableUntil: new Date('2026-02-01T00:00:00.000Z'),
        }),
        { owned: true, reachable: false },
        now,
      ),
    ).toBe(true);
  });

  it('shows a locked item only when it is acquirable and its achievement can be earned', () => {
    expect(isVisible(item(), { owned: false, reachable: true }, now)).toBe(true);
    expect(isVisible(item(), { owned: false, reachable: false }, now)).toBe(false);
  });

  it('hides planned, retired, ended, and not-yet-available content the user does not own', () => {
    for (const hidden of [
      item({ status: 'planned' }),
      item({ status: 'retired' }),
      item({
        availability: 'limited',
        availableFrom: new Date('2026-01-01T00:00:00.000Z'),
        availableUntil: new Date('2026-02-01T00:00:00.000Z'),
      }),
      item({ source: 'season' }),
    ]) {
      expect(isVisible(hidden, { owned: false, reachable: true }, now)).toBe(false);
    }
    // A5.6: event content is acquirable during its event, but never reachable from the
    // collection: it stays out of sight until owned (no FOMO).
    expect(isVisible(item({ source: 'event' }), { owned: false, reachable: false }, now)).toBe(
      false,
    );
    expect(isVisible(item({ source: 'event' }), { owned: true, reachable: false }, now)).toBe(true);
  });
});

describe('availability as the app sees it', () => {
  it('says whether it can be obtained now, with its window, never urgency', () => {
    expect(availabilityOf(item(), now)).toEqual({
      status: 'active',
      limited: false,
      availableFrom: null,
      availableUntil: null,
      obtainableNow: true,
    });
    expect(availabilityOf(item({ status: 'retired' }), now)).toMatchObject({
      status: 'retired',
      obtainableNow: false,
    });
  });
});

describe('unlock hints: structured truth, never copy or criterion names', () => {
  const achievement = {
    id: 'focus-hours:50',
    criterion: 'focused_minutes' as const,
    target: 3000,
    progressVisible: true,
    badge: { name: '50 Hours', description: '50 hours of counted focus.' },
  };

  it('describes an achievement unlock by its badge, unit, target, and progress', () => {
    const hint = unlockOf(item(), { achievement, value: 1234 });
    expect(hint).toEqual({
      type: 'achievement',
      achievementId: 'focus-hours:50',
      name: '50 Hours',
      description: '50 hours of counted focus.',
      unit: 'minutes',
      target: 3000,
      current: 1234,
    });
    expect(JSON.stringify(hint)).not.toMatch(/focused_minutes|counted_sessions|longest_streak/);
  });

  it('keeps hidden progress hidden, and caps nothing', () => {
    expect(
      unlockOf(item(), { achievement: { ...achievement, progressVisible: false }, value: 7 }),
    ).toMatchObject({ current: null, target: 3000 });
  });

  it('gives every content source a deliberate hint (system needs none)', () => {
    const hints = CONTENT_SOURCES.map((source) =>
      unlockOf(item({ source }), source === 'achievement' ? { achievement, value: 0 } : null),
    );
    expect(hints.map((hint) => hint?.type ?? null)).toEqual([
      null,
      'achievement',
      'event',
      'season',
    ]);
  });
});

describe('order and summary', () => {
  it('orders by catalog order, then id, never by ownership', () => {
    const items = [
      item({ id: 'b', sortOrder: 2 }),
      item({ id: 'a', sortOrder: 2 }),
      item({ id: 'z', sortOrder: 1 }),
    ];
    expect([...items].sort(byCatalogOrder).map((i) => i.id)).toEqual(['z', 'a', 'b']);
  });

  it('counts owned and visible items per section, without a percentage', () => {
    expect(summarize([{ owned: true }, { owned: false }, { owned: true }])).toEqual({
      owned: 2,
      total: 3,
    });
  });
});
