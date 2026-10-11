import { type DeliveryFacts, decideDelivery, informationalWait } from './notification-rules.js';

const at = (iso: string) => new Date(iso);

/** Facts under which a notification is sent: everything allows it. */
function facts(change: Partial<DeliveryFacts> = {}): DeliveryFacts {
  return {
    now: at('2026-11-02T10:00:00Z'),
    timeZone: 'UTC',
    userActive: true,
    categoryEnabled: true,
    deviceCount: 1,
    relevant: true,
    requested: false,
    expiresAt: at('2026-11-03T10:00:00Z'),
    focusUntil: null,
    unrequestedSentToday: 0,
    maxUnrequestedPerDay: 2,
    informationalHours: { start: 9, end: 21 },
    ...change,
  };
}

describe('decideDelivery', () => {
  it('sends when everything allows it', () => {
    expect(decideDelivery(facts())).toEqual({ action: 'send' });
  });

  it('never sends to a suspended or banned person', () => {
    expect(decideDelivery(facts({ userActive: false }))).toEqual({
      action: 'skip',
      reason: 'user_inactive',
    });
  });

  it('never sends a category the person has not turned on', () => {
    expect(decideDelivery(facts({ categoryEnabled: false }))).toEqual({
      action: 'skip',
      reason: 'category_off',
    });
  });

  it('drops a notification that is no longer timely or relevant', () => {
    expect(decideDelivery(facts({ expiresAt: at('2026-11-02T10:00:00Z') }))).toEqual({
      action: 'skip',
      reason: 'expired',
    });
    expect(decideDelivery(facts({ relevant: false }))).toEqual({
      action: 'skip',
      reason: 'not_relevant',
    });
  });

  it('skips a person with no registered device', () => {
    expect(decideDelivery(facts({ deviceCount: 0 }))).toEqual({
      action: 'skip',
      reason: 'no_device',
    });
  });

  it('waits until the focus session is over (docs/02), whatever the category', () => {
    const until = at('2026-11-02T10:40:00Z');
    expect(decideDelivery(facts({ focusUntil: until }))).toEqual({
      action: 'defer',
      until,
      cause: 'focus',
    });
    expect(decideDelivery(facts({ focusUntil: until, requested: true }))).toEqual({
      action: 'defer',
      until,
      cause: 'focus',
    });
    // A lease that has ended no longer holds anything back.
    expect(decideDelivery(facts({ focusUntil: at('2026-11-02T10:00:00Z') }))).toEqual({
      action: 'send',
    });
  });

  it('holds informational notices outside the day window until it opens', () => {
    expect(decideDelivery(facts({ now: at('2026-11-02T22:30:00Z') }))).toEqual({
      action: 'defer',
      until: at('2026-11-03T09:00:00Z'),
      cause: 'day_window',
    });
    // Reminders keep the time the person chose.
    expect(decideDelivery(facts({ now: at('2026-11-02T22:30:00Z'), requested: true }))).toEqual({
      action: 'send',
    });
  });

  it('drops informational notices beyond the daily limit, but never the person’s own reminders', () => {
    expect(decideDelivery(facts({ unrequestedSentToday: 1 }))).toEqual({ action: 'send' });
    expect(decideDelivery(facts({ unrequestedSentToday: 2 }))).toEqual({
      action: 'skip',
      reason: 'daily_limit',
    });
    expect(decideDelivery(facts({ unrequestedSentToday: 5, requested: true }))).toEqual({
      action: 'send',
    });
    expect(decideDelivery(facts({ maxUnrequestedPerDay: 0 }))).toEqual({
      action: 'skip',
      reason: 'daily_limit',
    });
  });

  it('checks the person and the category before anything that only waits', () => {
    expect(
      decideDelivery(facts({ categoryEnabled: false, focusUntil: at('2026-11-02T11:00:00Z') })),
    ).toEqual({ action: 'skip', reason: 'category_off' });
    expect(decideDelivery(facts({ userActive: false, categoryEnabled: false }))).toEqual({
      action: 'skip',
      reason: 'user_inactive',
    });
  });

  it('waits for focus to end before applying the day window', () => {
    // Focus ends at 21:30; the window then is closed, so the next attempt waits again.
    expect(
      decideDelivery(
        facts({ now: at('2026-11-02T20:50:00Z'), focusUntil: at('2026-11-02T21:30:00Z') }),
      ),
    ).toEqual({ action: 'defer', until: at('2026-11-02T21:30:00Z'), cause: 'focus' });
  });
});

describe('informationalWait', () => {
  const hours = { start: 9, end: 21 };

  it('is null inside the window', () => {
    expect(informationalWait(at('2026-11-02T09:00:00Z'), 'UTC', hours)).toBeNull();
    expect(informationalWait(at('2026-11-02T20:59:00Z'), 'UTC', hours)).toBeNull();
  });

  it('opens later today before the window, and tomorrow after it', () => {
    expect(informationalWait(at('2026-11-02T06:15:00Z'), 'UTC', hours)).toEqual(
      at('2026-11-02T09:00:00Z'),
    );
    expect(informationalWait(at('2026-11-02T21:00:00Z'), 'UTC', hours)).toEqual(
      at('2026-11-03T09:00:00Z'),
    );
  });

  it('follows the person’s time zone', () => {
    // 22:00 UTC is 09:00 the next day in Sydney (UTC+11 in November): inside the window.
    expect(informationalWait(at('2026-11-02T22:00:00Z'), 'Australia/Sydney', hours)).toBeNull();
    // 12:00 UTC is 04:00 in Los Angeles (UTC−8): it opens at 09:00 local, 17:00 UTC.
    expect(informationalWait(at('2026-11-02T12:00:00Z'), 'America/Los_Angeles', hours)).toEqual(
      at('2026-11-02T17:00:00Z'),
    );
  });
});
