import {
  addDays,
  compareLocalDates,
  daysBetween,
  daysInMonth,
  firstDateOfMonth,
  isLocalDate,
  lastDateOfMonth,
  weekStartOf,
} from './local-date.js';

describe('local dates ("YYYY-MM-DD", no time zone)', () => {
  it('recognises valid calendar dates only', () => {
    expect(isLocalDate('2026-09-30')).toBe(true);
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-9-30')).toBe(false);
    expect(isLocalDate('2026-09-31')).toBe(false);
    expect(isLocalDate('2026-09-30T00:00:00Z')).toBe(false);
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2026-09-15', 0)).toBe('2026-09-15');
  });

  it('counts the days from one date to another', () => {
    expect(daysBetween('2026-09-01', '2026-09-30')).toBe(29);
    expect(daysBetween('2026-09-30', '2026-09-01')).toBe(-29);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('compares dates in calendar order', () => {
    expect(compareLocalDates('2026-09-30', '2026-10-01')).toBeLessThan(0);
    expect(compareLocalDates('2026-10-01', '2026-09-30')).toBeGreaterThan(0);
    expect(compareLocalDates('2026-10-01', '2026-10-01')).toBe(0);
  });

  it('knows the days of each month, leap years included', () => {
    expect(daysInMonth({ year: 2026, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2028, month: 2 })).toBe(29);
    expect(daysInMonth({ year: 2100, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2000, month: 2 })).toBe(29);
    expect(daysInMonth({ year: 2026, month: 9 })).toBe(30);
    expect(daysInMonth({ year: 2026, month: 12 })).toBe(31);
    expect(firstDateOfMonth({ year: 2026, month: 9 })).toBe('2026-09-01');
    expect(lastDateOfMonth({ year: 2028, month: 2 })).toBe('2028-02-29');
  });

  describe('weeks run Monday to Sunday', () => {
    it.each([
      ['2026-09-28', '2026-09-28'], // Monday
      ['2026-09-29', '2026-09-28'],
      ['2026-10-03', '2026-09-28'], // Saturday
      ['2026-10-04', '2026-09-28'], // Sunday: still the week that began on Monday
      ['2026-10-05', '2026-10-05'], // the next Monday
      ['2027-01-01', '2026-12-28'], // across a year end
      ['2028-03-01', '2028-02-28'], // across a leap day
    ])('%s is in the week starting %s', (date, monday) => {
      expect(weekStartOf(date)).toBe(monday);
    });

    it('does not depend on the process time zone', () => {
      const original = process.env['TZ'];
      try {
        for (const zone of ['Pacific/Kiritimati', 'America/Los_Angeles', 'UTC']) {
          process.env['TZ'] = zone;
          expect(weekStartOf('2026-10-04')).toBe('2026-09-28');
          expect(addDays('2026-10-04', 1)).toBe('2026-10-05');
        }
      } finally {
        if (original === undefined) delete process.env['TZ'];
        else process.env['TZ'] = original;
      }
    });
  });
});
