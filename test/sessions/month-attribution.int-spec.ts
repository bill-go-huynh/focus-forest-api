import { Test, type TestingModule } from '@nestjs/testing';

import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { TimezoneRequiredError } from '../../src/sessions/attribution/month-context.js';
import { MonthAttributionService } from '../../src/sessions/attribution/month-attribution.service.js';

const HCM = 'Asia/Ho_Chi_Minh';
const NY = 'America/New_York';
const at = (iso: string) => new Date(iso);

describe('month attribution (PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let attribution: MonthAttributionService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    attribution = moduleRef.get(MonthAttributionService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  async function createUser(timezone: string | null, email = 'ada@example.com'): Promise<string> {
    const user = await prisma.user.create({ data: { email, passwordHash: 'unused', timezone } });
    return user.id;
  }

  const setTimezone = (userId: string, timezone: string) =>
    prisma.user.update({ where: { id: userId }, data: { timezone } });

  const contextsOf = (userId: string) =>
    prisma.monthAttributionContext.findMany({
      where: { userId },
      orderBy: { startsAt: 'asc' },
    });

  describe('the first session of a month', () => {
    it('creates the month context from the profile time zone', async () => {
      const userId = await createUser(HCM);

      const result = await attribution.attribute(userId, at('2026-09-15T20:00:00.000Z'));

      expect(result).toEqual({ localDate: '2026-09-16', year: 2026, month: 9, timeZone: HCM });
      const [context] = await contextsOf(userId);
      expect(context).toMatchObject({
        year: 2026,
        month: 9,
        timezone: HCM,
        startsAt: at('2026-08-31T17:00:00.000Z'),
        endsAt: at('2026-09-30T17:00:00.000Z'),
      });
    });

    it('refuses without a profile time zone and creates nothing', async () => {
      const userId = await createUser(null);

      await expect(attribution.attribute(userId, at('2026-09-15T20:00:00.000Z'))).rejects.toThrow(
        TimezoneRequiredError,
      );
      expect(await prisma.monthAttributionContext.count()).toBe(0);
    });
  });

  describe('a frozen month time zone', () => {
    it('keeps using the month context after the profile time zone changes', async () => {
      const userId = await createUser(HCM);
      await attribution.attribute(userId, at('2026-09-02T02:00:00.000Z'));
      await setTimezone(userId, NY);

      // 16 Sep in HCM, 15 Sep in New York.
      const later = await attribution.attribute(userId, at('2026-09-15T20:00:00.000Z'));

      expect(later).toEqual({ localDate: '2026-09-16', year: 2026, month: 9, timeZone: HCM });
      expect(await contextsOf(userId)).toHaveLength(1);
    });

    it('uses the new time zone from the next month, starting at the recorded boundary', async () => {
      const userId = await createUser(HCM);
      await attribution.attribute(userId, at('2026-09-02T02:00:00.000Z'));
      const [septemberBefore] = await contextsOf(userId);
      await setTimezone(userId, NY);

      const october = await attribution.attribute(userId, at('2026-10-10T12:00:00.000Z'));

      expect(october).toMatchObject({ year: 2026, month: 10, timeZone: NY });
      const [september, octoberContext] = await contextsOf(userId);
      expect(september).toEqual(septemberBefore);
      expect(octoberContext?.startsAt).toEqual(september?.endsAt);
      expect(octoberContext?.endsAt).toEqual(at('2026-11-01T04:00:00.000Z'));
    });
  });

  describe('month boundary after a time zone change', () => {
    it('westward (HCM → New York): no gap, and the real local date is kept', async () => {
      const userId = await createUser(HCM);
      await attribution.attribute(userId, at('2026-09-02T02:00:00.000Z'));
      await setTimezone(userId, NY);

      // After September ended in HCM (17:00Z), before October starts in New York (04:00Z).
      const instant = at('2026-09-30T20:00:00.000Z');
      const result = await attribution.attribute(userId, instant);

      expect(result).toEqual({ localDate: '2026-09-30', year: 2026, month: 10, timeZone: NY });
      // The last instant of September still belongs to September, in HCM.
      expect(await attribution.attribute(userId, at('2026-09-30T16:59:59.999Z'))).toEqual({
        localDate: '2026-09-30',
        year: 2026,
        month: 9,
        timeZone: HCM,
      });
    });

    it('eastward (New York → HCM): no overlap, September keeps its New York end', async () => {
      const userId = await createUser(NY);
      await attribution.attribute(userId, at('2026-09-02T12:00:00.000Z'));
      await setTimezone(userId, HCM);

      // Already 1 October in HCM, still 30 September in New York.
      const stillSeptember = await attribution.attribute(userId, at('2026-09-30T20:00:00.000Z'));
      const october = await attribution.attribute(userId, at('2026-10-01T04:00:00.000Z'));

      expect(stillSeptember).toEqual({
        localDate: '2026-09-30',
        year: 2026,
        month: 9,
        timeZone: NY,
      });
      expect(october).toEqual({ localDate: '2026-10-01', year: 2026, month: 10, timeZone: HCM });
    });

    it('a late offline session is found by its instant and never moves a boundary', async () => {
      const userId = await createUser(HCM);
      await attribution.attribute(userId, at('2026-09-02T02:00:00.000Z'));
      await setTimezone(userId, NY);
      await attribution.attribute(userId, at('2026-10-10T12:00:00.000Z'));
      const before = await contextsOf(userId);

      // Submitted after October exists; it started on 20 September.
      const late = await attribution.attribute(userId, at('2026-09-20T03:00:00.000Z'));

      expect(late).toEqual({ localDate: '2026-09-20', year: 2026, month: 9, timeZone: HCM });
      expect(await contextsOf(userId)).toEqual(before);
    });

    it('a late session for a month with no context fits between its neighbours', async () => {
      const userId = await createUser(NY);
      await attribution.attribute(userId, at('2026-10-10T12:00:00.000Z')); // October, New York
      await setTimezone(userId, HCM);
      const [octoberBefore] = await contextsOf(userId);

      // 1 Oct 03:00 in HCM, but October (New York) has not started yet: this is September.
      const late = await attribution.attribute(userId, at('2026-09-30T20:00:00.000Z'));

      expect(late).toEqual({ localDate: '2026-10-01', year: 2026, month: 9, timeZone: HCM });
      const [september, october] = await contextsOf(userId);
      expect(october).toEqual(octoberBefore);
      expect(september?.endsAt).toEqual(october?.startsAt);
    });
  });

  it('chains many contexts with no gap or overlap, each instant in exactly one', async () => {
    const userId = await createUser(HCM);
    const plan: [string, string][] = [
      [HCM, '2026-08-10T00:00:00.000Z'],
      [NY, '2026-09-10T00:00:00.000Z'],
      ['Pacific/Kiritimati', '2026-10-10T00:00:00.000Z'],
      ['Pacific/Pago_Pago', '2026-11-10T00:00:00.000Z'],
      ['Asia/Kolkata', '2026-12-10T00:00:00.000Z'],
    ];
    for (const [timezone, instant] of plan) {
      await setTimezone(userId, timezone);
      await attribution.attribute(userId, at(instant));
    }

    const contexts = await contextsOf(userId);
    expect(contexts.map((c) => c.month)).toEqual([8, 9, 10, 11, 12]);
    for (let i = 0; i + 1 < contexts.length; i++) {
      expect(contexts[i + 1]?.startsAt).toEqual(contexts[i]?.endsAt);
    }
    for (const context of contexts.slice(1)) {
      for (const offset of [-1, 0]) {
        const instant = new Date(context.startsAt.getTime() + offset);
        const owners = await prisma.monthAttributionContext.count({
          where: { userId, startsAt: { lte: instant }, endsAt: { gt: instant } },
        });
        expect(owners).toBe(1);
      }
    }
  });

  describe('concurrency', () => {
    it('creates one context when the same month is attributed concurrently', async () => {
      const userId = await createUser(HCM);

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          attribution.attribute(userId, at(`2026-09-1${i}T08:00:00.000Z`)),
        ),
      );

      expect(await contextsOf(userId)).toHaveLength(1);
      expect(new Set(results.map((r) => `${r.year}-${r.month}-${r.timeZone}`))).toEqual(
        new Set([`2026-9-${HCM}`]),
      );
    });

    it('makes a request wait for a context another request is creating, then reuses it', async () => {
      const userId = await createUser(HCM);
      let created!: () => void;
      let commit!: () => void;
      const isCreated = new Promise<void>((resolve) => (created = resolve));
      const mayCommit = new Promise<void>((resolve) => (commit = resolve));

      // A creates September in its transaction and holds it uncommitted.
      const first = prisma.$transaction(async (tx) => {
        const result = await attribution.attribute(userId, at('2026-09-10T08:00:00.000Z'), tx);
        created();
        await mayCommit;
        return result;
      });
      await isCreated;
      // B needs September too. It must not create a second one.
      const second = attribution.attribute(userId, at('2026-09-20T08:00:00.000Z'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      commit();

      const [a, b] = await Promise.all([first, second]);
      expect(b).toMatchObject({ year: 2026, month: 9, timeZone: a.timeZone });
      expect(await contextsOf(userId)).toHaveLength(1);
    });

    it('keeps adjacent months contiguous when they are created concurrently', async () => {
      const userId = await createUser(HCM);

      await Promise.all([
        attribution.attribute(userId, at('2026-09-15T08:00:00.000Z')),
        attribution.attribute(userId, at('2026-10-15T08:00:00.000Z')),
        attribution.attribute(userId, at('2026-11-15T08:00:00.000Z')),
      ]);

      const contexts = await contextsOf(userId);
      expect(contexts.map((c) => c.month)).toEqual([9, 10, 11]);
      expect(contexts[1]?.startsAt).toEqual(contexts[0]?.endsAt);
      expect(contexts[2]?.startsAt).toEqual(contexts[1]?.endsAt);
    });
  });

  it("never uses or changes another user's contexts", async () => {
    const ada = await createUser(HCM, 'ada@example.com');
    const grace = await createUser(NY, 'grace@example.com');
    await attribution.attribute(ada, at('2026-09-15T20:00:00.000Z'));

    const graces = await attribution.attribute(grace, at('2026-09-15T20:00:00.000Z'));

    expect(graces).toEqual({ localDate: '2026-09-15', year: 2026, month: 9, timeZone: NY });
    expect(await contextsOf(ada)).toHaveLength(1);
    expect(await contextsOf(grace)).toHaveLength(1);
  });

  describe('database integrity', () => {
    async function insert(userId: string, month: number, startsAt: string, endsAt: string) {
      return prisma.monthAttributionContext.create({
        data: {
          userId,
          year: 2026,
          month,
          timezone: HCM,
          startsAt: at(startsAt),
          endsAt: at(endsAt),
        },
      });
    }

    it('allows one context per user and month', async () => {
      const userId = await createUser(HCM);
      await insert(userId, 9, '2026-08-31T17:00:00.000Z', '2026-09-30T17:00:00.000Z');
      await expect(
        insert(userId, 9, '2026-08-31T17:00:00.000Z', '2026-09-30T17:00:00.000Z'),
      ).rejects.toThrow();
    });

    it.each([
      ['month 0', 0, '2026-08-31T17:00:00.000Z', '2026-09-30T17:00:00.000Z'],
      ['month 13', 13, '2026-08-31T17:00:00.000Z', '2026-09-30T17:00:00.000Z'],
      ['an empty interval', 9, '2026-09-30T17:00:00.000Z', '2026-09-30T17:00:00.000Z'],
      ['a reversed interval', 9, '2026-09-30T17:00:00.000Z', '2026-08-31T17:00:00.000Z'],
    ])('rejects %s', async (_case, month, startsAt, endsAt) => {
      const userId = await createUser(HCM);
      await expect(insert(userId, month, startsAt, endsAt)).rejects.toThrow();
    });
  });
});
