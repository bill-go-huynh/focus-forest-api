import { isIanaTimeZone } from './time-zone.js';

describe('isIanaTimeZone', () => {
  it.each([
    'UTC',
    'Asia/Ho_Chi_Minh',
    'Europe/Kyiv',
    'Europe/Zurich',
    'America/Argentina/Buenos_Aires',
    'America/Port-au-Prince',
    'Etc/GMT-7',
  ])('accepts the IANA time zone %s', (zone) => {
    expect(isIanaTimeZone(zone)).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['a UTC offset', '+07:00'],
    ['a GMT offset', 'GMT+7'],
    ['an abbreviation', 'EST'],
    ['an unknown zone', 'Mars/Olympus'],
    ['a lowercase name', 'asia/ho_chi_minh'],
    ['surrounding whitespace', ' Europe/Zurich '],
    ['a very long value', `Europe/${'A'.repeat(100)}`],
  ])('rejects %s', (_case, zone) => {
    expect(isIanaTimeZone(zone)).toBe(false);
  });
});
