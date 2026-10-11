import { instantAt, localMinutesOf, minutesOfReminderTime } from './local-time.js';

const at = (iso: string) => new Date(iso);

describe('local time', () => {
  it('reads the local minutes of the day', () => {
    expect(localMinutesOf(at('2026-11-02T10:15:00Z'), 'UTC')).toBe(615);
    expect(localMinutesOf(at('2026-11-02T10:15:00Z'), 'Asia/Ho_Chi_Minh')).toBe(17 * 60 + 15);
    expect(localMinutesOf(at('2026-11-02T00:30:00Z'), 'America/New_York')).toBe(19 * 60 + 30);
  });

  it('finds the instant of a local date and time', () => {
    expect(instantAt('2026-11-02', 9 * 60, 'UTC')).toEqual(at('2026-11-02T09:00:00Z'));
    expect(instantAt('2026-11-02', 20 * 60 + 30, 'Asia/Ho_Chi_Minh')).toEqual(
      at('2026-11-02T13:30:00Z'),
    );
    expect(instantAt('2026-11-02', 0, 'Australia/Sydney')).toEqual(at('2026-11-01T13:00:00Z'));
  });

  it('handles daylight saving changes', () => {
    // Berlin moves from +01:00 to +02:00 on 2027-03-28 at 02:00 local.
    expect(instantAt('2027-03-27', 9 * 60, 'Europe/Berlin')).toEqual(at('2027-03-27T08:00:00Z'));
    expect(instantAt('2027-03-28', 9 * 60, 'Europe/Berlin')).toEqual(at('2027-03-28T07:00:00Z'));
    // 02:30 does not exist that day: the first instant after the gap.
    expect(instantAt('2027-03-28', 2 * 60 + 30, 'Europe/Berlin')).toEqual(
      at('2027-03-28T01:00:00Z'),
    );
    // Back to +01:00 on 2026-10-25.
    expect(instantAt('2026-10-25', 9 * 60, 'Europe/Berlin')).toEqual(at('2026-10-25T08:00:00Z'));
  });

  it('parses reminder times', () => {
    expect(minutesOfReminderTime('00:00')).toBe(0);
    expect(minutesOfReminderTime('07:45')).toBe(465);
    expect(minutesOfReminderTime('23:59')).toBe(1439);
  });
});
