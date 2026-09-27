import { addMonths, localDateOf, localMonthOf, monthStart, startOfLocalDate } from './calendar.js';

const at = (iso: string) => new Date(iso);

describe('calendar', () => {
  describe('localDateOf', () => {
    it.each([
      ['2026-09-27T10:00:00.000Z', 'Asia/Ho_Chi_Minh', '2026-09-27'],
      ['2026-09-27T17:00:00.000Z', 'Asia/Ho_Chi_Minh', '2026-09-28'],
      ['2026-09-27T03:59:59.999Z', 'America/New_York', '2026-09-26'],
      // Half-hour offset: 23:59:59 and 00:00 in India (UTC+5:30).
      ['2026-09-30T18:29:59.999Z', 'Asia/Kolkata', '2026-09-30'],
      ['2026-09-30T18:30:00.000Z', 'Asia/Kolkata', '2026-10-01'],
      // UTC+14 is already the next day.
      ['2026-09-30T09:59:59.999Z', 'Pacific/Kiritimati', '2026-09-30'],
      ['2026-09-30T10:00:00.000Z', 'Pacific/Kiritimati', '2026-10-01'],
      // December → January.
      ['2027-01-01T04:59:59.999Z', 'America/New_York', '2026-12-31'],
      ['2027-01-01T05:00:00.000Z', 'America/New_York', '2027-01-01'],
      // Leap day.
      ['2028-02-29T10:00:00.000Z', 'Asia/Ho_Chi_Minh', '2028-02-29'],
      // DST: the repeated 01:30 on 1 November in New York is still 1 November both times.
      ['2026-11-01T05:30:00.000Z', 'America/New_York', '2026-11-01'],
      ['2026-11-01T06:30:00.000Z', 'America/New_York', '2026-11-01'],
      // DST: Zurich springs forward on 29 March and falls back on 25 October.
      ['2026-03-29T00:30:00.000Z', 'Europe/Zurich', '2026-03-29'],
      ['2026-10-25T00:30:00.000Z', 'Europe/Zurich', '2026-10-25'],
    ])('%s in %s is %s', (iso, timeZone, expected) => {
      expect(localDateOf(at(iso), timeZone)).toBe(expected);
    });

    it('uses the start time: a session from 23:50 on 30 September belongs to 30 September', () => {
      const startedAt = at('2026-09-30T16:50:00.000Z'); // 23:50 in Ho Chi Minh City
      expect(localDateOf(startedAt, 'Asia/Ho_Chi_Minh')).toBe('2026-09-30');
      expect(localMonthOf(startedAt, 'Asia/Ho_Chi_Minh')).toEqual({ year: 2026, month: 9 });
    });

    it('accepts legacy IANA aliases the runtime reports', () => {
      expect(localDateOf(at('2026-09-27T17:00:00.000Z'), 'Asia/Saigon')).toBe('2026-09-28');
    });
  });

  it('localMonthOf crosses the year boundary', () => {
    expect(localMonthOf(at('2027-01-01T05:00:00.000Z'), 'America/New_York')).toEqual({
      year: 2027,
      month: 1,
    });
  });

  describe('startOfLocalDate and monthStart', () => {
    it.each([
      [2026, 9, 'Asia/Ho_Chi_Minh', '2026-08-31T17:00:00.000Z'],
      [2026, 10, 'Asia/Kolkata', '2026-09-30T18:30:00.000Z'],
      [2026, 10, 'Pacific/Kiritimati', '2026-09-30T10:00:00.000Z'],
      [2026, 11, 'America/New_York', '2026-11-01T04:00:00.000Z'], // still daylight time
      [2026, 12, 'America/New_York', '2026-12-01T05:00:00.000Z'], // standard time
      [2026, 3, 'Europe/Zurich', '2026-02-28T23:00:00.000Z'],
      [2026, 4, 'Europe/Zurich', '2026-03-31T22:00:00.000Z'],
      [2027, 1, 'America/New_York', '2027-01-01T05:00:00.000Z'],
      [2028, 3, 'Asia/Ho_Chi_Minh', '2028-02-29T17:00:00.000Z'],
    ])('%i-%i starts in %s at %s', (year, month, timeZone, expected) => {
      expect(monthStart({ year, month }, timeZone).toISOString()).toBe(expected);
    });

    it('is the first instant of the local date when midnight does not exist', () => {
      // Santiago skips from 23:59:59 on 5 September to 01:00 on 6 September.
      const start = startOfLocalDate('2026-09-06', 'America/Santiago');
      expect(start.toISOString()).toBe('2026-09-06T04:00:00.000Z');
      expect(localDateOf(new Date(start.getTime() - 1), 'America/Santiago')).toBe('2026-09-05');
    });
  });

  it('addMonths moves across years in both directions', () => {
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 9 }, 0)).toEqual({ year: 2026, month: 9 });
  });
});
