import { checkCancelRestDay, checkNewRestDay } from './rest-days.js';

const rules = { maxPerWeek: 2, allowSameDay: true };
const TODAY = '2026-10-07'; // Wednesday; the week runs 5–11 October

describe('scheduling a rest day', () => {
  it('accepts today and future dates', () => {
    expect(checkNewRestDay({ date: TODAY, today: TODAY, existing: [] }, rules)).toBeNull();
    expect(checkNewRestDay({ date: '2026-10-08', today: TODAY, existing: [] }, rules)).toBeNull();
    expect(checkNewRestDay({ date: '2027-01-15', today: TODAY, existing: [] }, rules)).toBeNull();
  });

  it('never accepts a past date', () => {
    expect(checkNewRestDay({ date: '2026-10-06', today: TODAY, existing: [] }, rules)).toBe(
      'rest_day_in_past',
    );
  });

  it('accepts today only when same-day rest days are allowed', () => {
    expect(
      checkNewRestDay(
        { date: TODAY, today: TODAY, existing: [] },
        { ...rules, allowSameDay: false },
      ),
    ).toBe('rest_day_today_not_allowed');
  });

  it('refuses dates more than a year ahead', () => {
    expect(checkNewRestDay({ date: '2027-10-08', today: TODAY, existing: [] }, rules)).toBe(
      'rest_day_too_far_ahead',
    );
    expect(checkNewRestDay({ date: '2027-10-07', today: TODAY, existing: [] }, rules)).toBeNull();
  });

  it('keeps to the weekly allowance, Monday to Sunday', () => {
    const existing = ['2026-10-05', '2026-10-11'];
    expect(checkNewRestDay({ date: '2026-10-09', today: TODAY, existing }, rules)).toBe(
      'rest_allowance_used',
    );
    // The next week has its own allowance.
    expect(checkNewRestDay({ date: '2026-10-12', today: TODAY, existing }, rules)).toBeNull();
    // Rest days of the previous week don't count.
    expect(
      checkNewRestDay(
        { date: '2026-10-08', today: TODAY, existing: ['2026-10-03', '2026-10-04'] },
        rules,
      ),
    ).toBeNull();
    expect(
      checkNewRestDay({ date: '2026-10-08', today: TODAY, existing }, { ...rules, maxPerWeek: 3 }),
    ).toBeNull();
  });
});

describe('cancelling a rest day', () => {
  it('is possible until the day ends', () => {
    expect(checkCancelRestDay({ date: TODAY, today: TODAY })).toBeNull();
    expect(checkCancelRestDay({ date: '2026-10-09', today: TODAY })).toBeNull();
  });

  it('is not possible once the day is over', () => {
    expect(checkCancelRestDay({ date: '2026-10-06', today: TODAY })).toBe('rest_day_in_past');
  });
});
