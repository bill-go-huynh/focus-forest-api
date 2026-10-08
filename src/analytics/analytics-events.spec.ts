import { ANALYTICS_EVENT_NAMES, acceptEvent, bucketMinutes } from './analytics-events.js';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const event = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'app_opened',
  occurredAt: '2026-10-08T11:59:00.000Z',
  localDate: '2026-10-08',
  platform: 'ios',
  appVersion: '0.1.0',
  ...overrides,
});

describe('product analytics events (CR.1)', () => {
  it('has a closed allowlist of event names, with no free-text event', () => {
    expect(ANALYTICS_EVENT_NAMES).toEqual([
      'app_opened',
      'app_foregrounded',
      'focus_started',
      'focus_cancelled',
      'tree_details_opened',
      'forest_opened',
      'recap_opened',
      'insights_opened',
    ]);
  });

  it('accepts a known event as a row, with only the allowlisted properties', () => {
    expect(
      acceptEvent(
        event({ name: 'focus_started', props: { plannedMinutes: 25, topicName: 'Thesis' } }),
        NOW,
      ),
    ).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'focus_started',
      occurredAt: new Date('2026-10-08T11:59:00.000Z'),
      localDate: '2026-10-08',
      platform: 'ios',
      appVersion: '0.1.0',
      props: { plannedMinutes: 25 },
    });
    expect(acceptEvent(event({ props: { note: 'secret' } }), NOW)?.props).toEqual({});
  });

  it('keeps only whole numbers in range for numeric properties', () => {
    const props = (p: Record<string, unknown>) =>
      acceptEvent(event({ name: 'recap_opened', props: p }), NOW)?.props;
    expect(props({ year: 2026, month: 9 })).toEqual({ year: 2026, month: 9 });
    expect(props({ year: '2026', month: 13 })).toEqual({});
    expect(props({ year: 2026.5, month: 0 })).toEqual({});
    expect(
      acceptEvent(event({ name: 'focus_started', props: { plannedMinutes: 100_000 } }), NOW)?.props,
    ).toEqual({});
  });

  it('buckets cancelled focus, so no exact durations are kept', () => {
    expect([0, 1, 4, 5, 9, 10, 14, 15, 29, 30, 59, 60, 400].map(bucketMinutes)).toEqual([
      0, 0, 0, 5, 5, 10, 10, 15, 15, 30, 30, 60, 60,
    ]);
    expect(
      acceptEvent(event({ name: 'focus_cancelled', props: { elapsedMinutes: 23 } }), NOW)?.props,
    ).toEqual({ elapsedMinutes: 15 });
  });

  it('ignores unknown names, unknown platforms, and events outside the window', () => {
    expect(acceptEvent(event({ name: 'screen_viewed' }), NOW)).toBeNull();
    expect(acceptEvent(event({ platform: 'symbian' }), NOW)).toBeNull();
    expect(acceptEvent(event({ occurredAt: '2026-09-07T11:59:00.000Z' }), NOW)).toBeNull();
    expect(acceptEvent(event({ occurredAt: '2026-10-08T12:06:00.000Z' }), NOW)).toBeNull();
    // Within the clock skew allowed.
    expect(acceptEvent(event({ occurredAt: '2026-10-08T12:04:00.000Z' }), NOW)).not.toBeNull();
  });

  it('ignores a local date more than a day from the instant', () => {
    expect(acceptEvent(event({ localDate: '2026-10-09' }), NOW)).not.toBeNull();
    expect(acceptEvent(event({ localDate: '2026-10-10' }), NOW)).toBeNull();
    expect(acceptEvent(event({ localDate: '2026-10-06' }), NOW)).toBeNull();
  });
});
