import { hemisphereFor } from './hemisphere.js';

describe('hemisphereFor', () => {
  it('uses the hemisphere the user set, first', () => {
    expect(hemisphereFor('south', 'Europe/Paris')).toEqual({ hemisphere: 'south', source: 'set' });
    expect(hemisphereFor('north', 'Australia/Sydney')).toEqual({
      hemisphere: 'north',
      source: 'set',
    });
  });

  it('derives it from the time zone when unset', () => {
    for (const zone of [
      'Australia/Sydney',
      'Pacific/Auckland',
      'America/Argentina/Buenos_Aires',
      'America/Santiago',
      'America/Sao_Paulo',
      'Africa/Johannesburg',
      'Indian/Mauritius',
      'Antarctica/McMurdo',
    ]) {
      expect(hemisphereFor(null, zone)).toEqual({ hemisphere: 'south', source: 'time_zone' });
    }
    for (const zone of ['Europe/London', 'Asia/Ho_Chi_Minh', 'America/New_York', 'UTC']) {
      expect(hemisphereFor(null, zone)).toEqual({ hemisphere: 'north', source: 'time_zone' });
    }
  });

  it('defaults to north without a time zone', () => {
    expect(hemisphereFor(null, null)).toEqual({ hemisphere: 'north', source: 'default' });
  });
});
