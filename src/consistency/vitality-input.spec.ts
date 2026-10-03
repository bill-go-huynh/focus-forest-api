import { vitalityInputFor } from './vitality-input.js';

describe('vitality input from activity history', () => {
  it('passes real focus and planned rest only: a recovered day is neither active nor a goal day', () => {
    const input = vitalityInputFor(
      '2026-10-07',
      {
        activeDates: ['2026-10-04', '2026-10-06', '2026-10-07'],
        restDates: ['2026-10-03'],
        recoveredDates: ['2026-10-05'],
      },
      ['2026-10-06', '2026-10-07'],
    );
    expect(input).toEqual({
      today: '2026-10-07',
      activeDates: ['2026-10-04', '2026-10-06', '2026-10-07'],
      restDates: ['2026-10-03'],
      goalMetDates: ['2026-10-06', '2026-10-07'],
    });
  });

  it('keeps focus on a planned rest day as activity', () => {
    const input = vitalityInputFor(
      '2026-10-07',
      { activeDates: ['2026-10-06', '2026-10-07'], restDates: ['2026-10-07'], recoveredDates: [] },
      ['2026-10-07'],
    );
    expect(input.activeDates).toEqual(['2026-10-06', '2026-10-07']);
    expect(input.goalMetDates).toEqual(['2026-10-07']);
  });
});
