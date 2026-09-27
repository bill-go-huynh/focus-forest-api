import { monthStart } from './calendar.js';
import {
  attributeInContext,
  planMonthContext,
  TimezoneRequiredError,
  type MonthContext,
} from './month-context.js';

const HCM = 'Asia/Ho_Chi_Minh';
const NY = 'America/New_York';
const at = (iso: string) => new Date(iso);

function natural(year: number, month: number, timeZone: string): MonthContext {
  return {
    year,
    month,
    timeZone,
    startsAt: monthStart({ year, month }, timeZone),
    endsAt: monthStart({ year: month === 12 ? year + 1 : year, month: (month % 12) + 1 }, timeZone),
  };
}

const contains = (context: MonthContext, instant: Date) =>
  context.startsAt <= instant && instant < context.endsAt;

describe('planMonthContext', () => {
  it('without neighbours, uses the profile time zone and its calendar month', () => {
    const plan = planMonthContext({
      instant: at('2026-09-15T08:00:00.000Z'),
      profileTimeZone: HCM,
      previous: null,
      next: null,
    });
    expect(plan).toEqual(natural(2026, 9, HCM));
  });

  it('starts the next month exactly where the previous one ends, in the new time zone', () => {
    const september = natural(2026, 9, HCM);
    const plan = planMonthContext({
      instant: at('2026-10-05T12:00:00.000Z'),
      profileTimeZone: NY,
      previous: september,
      next: null,
    });
    expect(plan).toEqual({
      year: 2026,
      month: 10,
      timeZone: NY,
      startsAt: september.endsAt,
      endsAt: at('2026-11-01T04:00:00.000Z'),
    });
  });

  it('westward change: the instant between the two midnights goes to October, with its real date', () => {
    const september = natural(2026, 9, HCM); // ends 2026-09-30T17:00Z
    const instant = at('2026-09-30T20:00:00.000Z'); // 03:00 on 1 Oct in HCM, 16:00 on 30 Sep in NY

    const october = planMonthContext({
      instant,
      profileTimeZone: NY,
      previous: september,
      next: null,
    });

    expect(october).toMatchObject({ year: 2026, month: 10, timeZone: NY });
    expect(october.startsAt).toEqual(september.endsAt);
    expect(attributeInContext(october, instant)).toEqual({
      localDate: '2026-09-30',
      year: 2026,
      month: 10,
      timeZone: NY,
    });
  });

  it('eastward change: October starts where September (New York) ends, never overlapping', () => {
    const september = natural(2026, 9, NY); // ends 2026-10-01T04:00Z
    const instant = at('2026-10-01T05:00:00.000Z');

    const october = planMonthContext({
      instant,
      profileTimeZone: HCM,
      previous: september,
      next: null,
    });

    expect(october.startsAt).toEqual(september.endsAt);
    expect(october.endsAt).toEqual(at('2026-10-31T17:00:00.000Z'));
    expect(attributeInContext(october, instant).localDate).toBe('2026-10-01');
  });

  it('a late session for an earlier month ends at the existing next month, without taking from it', () => {
    const october = natural(2026, 10, NY); // starts 2026-10-01T04:00Z
    const instant = at('2026-09-30T20:00:00.000Z'); // 1 Oct 03:00 in HCM

    const september = planMonthContext({
      instant,
      profileTimeZone: HCM,
      previous: null,
      next: october,
    });

    expect(september).toMatchObject({ year: 2026, month: 9, timeZone: HCM });
    expect(september.startsAt).toEqual(at('2026-08-31T17:00:00.000Z'));
    expect(september.endsAt).toEqual(october.startsAt);
    // The real date in the context's time zone, not moved into September.
    expect(attributeInContext(september, instant).localDate).toBe('2026-10-01');
  });

  it('fills a month with no context between two existing ones, touching both', () => {
    const september = natural(2026, 9, HCM);
    const november = natural(2026, 11, NY);

    const october = planMonthContext({
      instant: at('2026-10-15T12:00:00.000Z'),
      profileTimeZone: 'Europe/Zurich',
      previous: september,
      next: november,
    });

    expect(october).toMatchObject({ year: 2026, month: 10, timeZone: 'Europe/Zurich' });
    expect(october.startsAt).toEqual(september.endsAt);
    expect(october.endsAt).toEqual(november.startsAt);
  });

  it('refuses to plan without a profile time zone', () => {
    expect(() =>
      planMonthContext({
        instant: at('2026-09-15T08:00:00.000Z'),
        profileTimeZone: null,
        previous: null,
        next: null,
      }),
    ).toThrow(TimezoneRequiredError);
  });

  describe('invariants around boundaries, for every pair of time zones', () => {
    const zones = [
      HCM,
      NY,
      'Asia/Kolkata',
      'Pacific/Kiritimati',
      'Europe/Zurich',
      'Pacific/Pago_Pago',
    ];
    const pairs = zones.flatMap((a) => zones.map((b) => [a, b] as const));
    // Every 30 minutes across two days on both sides of the October boundary.
    const instants = Array.from(
      { length: 4 * 48 },
      (_, i) => new Date(Date.parse('2026-09-29T00:00:00.000Z') + i * 30 * 60_000),
    );

    it.each(pairs)('September in %s, then the profile moves to %s', (first, profile) => {
      const september = natural(2026, 9, first);
      for (const instant of instants) {
        if (contains(september, instant)) continue;
        const plan = planMonthContext({
          instant,
          profileTimeZone: profile,
          previous: september,
          next: null,
        });
        expect(contains(plan, instant)).toBe(true);
        expect(plan.startsAt).toEqual(september.endsAt); // no gap, no overlap
        expect(plan).toMatchObject({ year: 2026, month: 10, timeZone: profile });
        // The date is the real one in the context's time zone.
        expect(attributeInContext(plan, instant).localDate).toBe(
          new Intl.DateTimeFormat('en-CA', { timeZone: profile }).format(instant),
        );
      }
    });

    it.each(pairs)(
      'October in %s exists, a late session arrives with the profile in %s',
      (first, profile) => {
        const october = natural(2026, 10, first);
        for (const instant of instants) {
          if (contains(october, instant) || instant >= october.endsAt) continue;
          const plan = planMonthContext({
            instant,
            profileTimeZone: profile,
            previous: null,
            next: october,
          });
          expect(contains(plan, instant)).toBe(true);
          expect(plan.endsAt).toEqual(october.startsAt);
          expect(plan).toMatchObject({ year: 2026, month: 9, timeZone: profile });
        }
      },
    );
  });
});

describe('attributeInContext', () => {
  it('uses the frozen context time zone', () => {
    const september = natural(2026, 9, HCM);
    const instant = at('2026-09-15T20:00:00.000Z'); // 16 Sep in HCM, 15 Sep in New York
    expect(attributeInContext(september, instant)).toEqual({
      localDate: '2026-09-16',
      year: 2026,
      month: 9,
      timeZone: HCM,
    });
  });

  it.each(['2026-08-31T16:59:59.999Z', '2026-09-30T17:00:00.000Z'])(
    'refuses an instant outside the context (%s)',
    (iso) => {
      expect(() => attributeInContext(natural(2026, 9, HCM), at(iso))).toThrow(/outside/);
    },
  );
});
