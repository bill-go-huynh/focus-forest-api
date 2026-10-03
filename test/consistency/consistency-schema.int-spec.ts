import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

const day = (date: string) => new Date(`${date}T00:00:00.000Z`);

// The database itself keeps these invariants, whatever code writes the rows.
describe('goals, rest days, and recoveries schema (PostgreSQL)', () => {
  let prisma: PrismaService;
  let close: () => Promise<void>;
  let userId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    userId = (await prisma.user.create({ data: { email: 'ada@example.com', passwordHash: 'x' } }))
      .id;
  });

  it('starts weekly goal versions on a Monday only', async () => {
    await prisma.weeklyGoalSetting.create({
      data: { userId, effectiveFrom: day('2026-10-05'), type: 'session_count', target: 5 },
    });
    await expect(
      prisma.weeklyGoalSetting.create({
        data: { userId, effectiveFrom: day('2026-10-11'), type: 'session_count', target: 5 },
      }),
    ).rejects.toThrow();
  });

  it('records a cleared weekly goal as a version without type and target, never half of one', async () => {
    await prisma.weeklyGoalSetting.create({
      data: { userId, effectiveFrom: day('2026-10-05'), type: null, target: null },
    });
    await expect(
      prisma.weeklyGoalSetting.create({
        data: { userId, effectiveFrom: day('2026-10-12'), type: null, target: 5 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.weeklyGoalSetting.create({
        data: { userId, effectiveFrom: day('2026-10-19'), type: 'session_count', target: null },
      }),
    ).rejects.toThrow();
  });

  it('keeps goal values within their bounds', async () => {
    await expect(
      prisma.dailyGoalSetting.create({
        data: { userId, effectiveFrom: day('2026-10-05'), minutes: 0 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.weeklyGoalSetting.create({
        data: { userId, effectiveFrom: day('2026-10-05'), type: 'focused_minutes', target: 0 },
      }),
    ).rejects.toThrow();
  });

  it('holds one version per user and date, and one rest day per user and date', async () => {
    await prisma.dailyGoalSetting.create({
      data: { userId, effectiveFrom: day('2026-10-05'), minutes: 30 },
    });
    await expect(
      prisma.dailyGoalSetting.create({
        data: { userId, effectiveFrom: day('2026-10-05'), minutes: 45 },
      }),
    ).rejects.toThrow();
    await prisma.restDay.create({ data: { userId, date: day('2026-10-08') } });
    await expect(
      prisma.restDay.create({ data: { userId, date: day('2026-10-08') } }),
    ).rejects.toThrow();
  });

  it('records a missed day once, with its return on the next day', async () => {
    await prisma.streakRecovery.create({
      data: {
        userId,
        missedDate: day('2026-10-05'),
        returnDate: day('2026-10-06'),
        mechanic: 'next_day_session',
      },
    });
    await expect(
      prisma.streakRecovery.create({
        data: {
          userId,
          missedDate: day('2026-10-05'),
          returnDate: day('2026-10-06'),
          mechanic: 'next_day_session',
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.streakRecovery.create({
        data: {
          userId,
          missedDate: day('2026-10-10'),
          returnDate: day('2026-10-12'),
          mechanic: 'next_day_session',
        },
      }),
    ).rejects.toThrow();
  });

  it('removes everything with the user', async () => {
    await prisma.restDay.create({ data: { userId, date: day('2026-10-08') } });
    await prisma.dailyGoalSetting.create({
      data: { userId, effectiveFrom: day('2026-10-05'), minutes: 30 },
    });
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.restDay.count()).toBe(0);
    expect(await prisma.dailyGoalSetting.count()).toBe(0);
  });
});
