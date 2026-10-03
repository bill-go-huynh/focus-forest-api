import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module.js';
import { FocusStatsService } from '../../src/focus-stats/focus-stats.service.js';
import type { FocusSessionStatus } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

const MIN = 60_000;
const SEPTEMBER = { year: 2026, month: 9 };
const OCTOBER = { year: 2026, month: 10 };

describe('focus statistics (PostgreSQL)', () => {
  let prisma: PrismaService;
  let stats: FocusStatsService;
  let close: () => Promise<void>;
  let ada: string;
  let bob: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      providers: [FocusStatsService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    stats = moduleRef.get(FocusStatsService);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await close();
  });

  async function createUser(email: string): Promise<string> {
    const user = await prisma.user.create({
      data: { email, passwordHash: 'not-a-real-hash', timezone: 'Asia/Ho_Chi_Minh' },
    });
    for (const month of [SEPTEMBER, OCTOBER]) {
      await prisma.monthAttributionContext.create({
        data: {
          userId: user.id,
          ...month,
          timezone: 'Asia/Ho_Chi_Minh',
          startsAt: new Date(Date.UTC(month.year, month.month - 1, 1) - 7 * 3_600_000),
          endsAt: new Date(Date.UTC(month.year, month.month, 1) - 7 * 3_600_000),
        },
      });
    }
    return user.id;
  }

  async function createTopic(userId: string): Promise<string> {
    const topic = await prisma.topic.create({
      data: {
        id: randomUUID(),
        userId,
        name: `Topic ${randomUUID().slice(0, 6)}`,
        icon: 'book',
        color: 'topic.1',
        createFingerprint: 'test',
      },
    });
    return topic.id;
  }

  async function addSession(
    userId: string,
    topicId: string,
    session: {
      startedAt: string;
      localDate: string;
      month: { year: number; month: number };
      minutes: number;
      status?: FocusSessionStatus;
    },
  ) {
    const startedAt = new Date(session.startedAt);
    const endedAt = new Date(startedAt.getTime() + session.minutes * MIN);
    await prisma.focusSession.create({
      data: {
        id: randomUUID(),
        userId,
        topicId,
        startedAt,
        submittedEndedAt: endedAt,
        plannedMinutes: session.minutes,
        pauseIntervals: [],
        effectiveEndedAt: endedAt,
        focusedMilliseconds: session.minutes * MIN,
        pausedMilliseconds: 0,
        status: session.status ?? 'completed',
        localDate: new Date(`${session.localDate}T00:00:00.000Z`),
        ...session.month,
        configVersion: 2,
      },
    });
  }

  let reading: string;
  let writing: string;

  beforeEach(async () => {
    ada = await createUser('ada@example.com');
    bob = await createUser('bob@example.com');
    reading = await createTopic(ada);
    writing = await createTopic(ada);

    // 01:00 on 30 September in Ho Chi Minh City is still 29 September in UTC.
    await addSession(ada, reading, {
      startedAt: '2026-09-29T18:00:00Z',
      localDate: '2026-09-30',
      month: SEPTEMBER,
      minutes: 30,
    });
    await addSession(ada, writing, {
      startedAt: '2026-09-30T02:00:00Z',
      localDate: '2026-09-30',
      month: SEPTEMBER,
      minutes: 20,
      status: 'ended_early',
    });
    await addSession(ada, reading, {
      startedAt: '2026-09-30T05:00:00Z',
      localDate: '2026-09-30',
      month: SEPTEMBER,
      minutes: 3,
      status: 'discarded',
    });
    await addSession(ada, writing, {
      startedAt: '2026-09-14T03:00:00Z',
      localDate: '2026-09-14',
      month: SEPTEMBER,
      minutes: 45,
    });
    // After a time zone change at the boundary: October's month, September's real date.
    await addSession(ada, reading, {
      startedAt: '2026-09-30T20:00:00Z',
      localDate: '2026-09-30',
      month: OCTOBER,
      minutes: 15,
    });
    await addSession(ada, reading, {
      startedAt: '2026-10-02T03:00:00Z',
      localDate: '2026-10-02',
      month: OCTOBER,
      minutes: 25,
    });
    // Another user's focus on the same day.
    await addSession(bob, await createTopic(bob), {
      startedAt: '2026-09-30T03:00:00Z',
      localDate: '2026-09-30',
      month: SEPTEMBER,
      minutes: 90,
    });
  });

  describe('monthDays', () => {
    it('totals the counted sessions of the month per stored local date', async () => {
      expect(await stats.monthDays(ada, SEPTEMBER)).toEqual([
        { date: '2026-09-14', focusedMilliseconds: 45 * MIN, sessionCount: 1 },
        { date: '2026-09-30', focusedMilliseconds: 50 * MIN, sessionCount: 2 },
      ]);
    });

    it('includes a session attributed to the month even when its date is outside it', async () => {
      expect(await stats.monthDays(ada, OCTOBER)).toEqual([
        { date: '2026-09-30', focusedMilliseconds: 15 * MIN, sessionCount: 1 },
        { date: '2026-10-02', focusedMilliseconds: 25 * MIN, sessionCount: 1 },
      ]);
    });

    it('is empty for a month without sessions', async () => {
      expect(await stats.monthDays(ada, { year: 2026, month: 8 })).toEqual([]);
    });
  });

  describe('daysBetween', () => {
    it('totals counted focus per local date, whatever month the sessions belong to', async () => {
      expect(await stats.daysBetween(ada, '2026-09-30', '2026-10-02')).toEqual([
        { date: '2026-09-30', focusedMilliseconds: 65 * MIN, sessionCount: 3 },
        { date: '2026-10-02', focusedMilliseconds: 25 * MIN, sessionCount: 1 },
      ]);
    });

    it('includes both ends of the range and nothing outside it', async () => {
      expect(await stats.daysBetween(ada, '2026-09-14', '2026-09-14')).toEqual([
        { date: '2026-09-14', focusedMilliseconds: 45 * MIN, sessionCount: 1 },
      ]);
      expect(await stats.daysBetween(ada, '2026-09-15', '2026-09-29')).toEqual([]);
    });
  });

  describe('monthTopics', () => {
    it('totals counted focus per topic of the month, largest first', async () => {
      expect(await stats.monthTopics(ada, SEPTEMBER)).toEqual([
        { topicId: writing, focusedMilliseconds: 65 * MIN, sessionCount: 2 },
        { topicId: reading, focusedMilliseconds: 30 * MIN, sessionCount: 1 },
      ]);
    });
  });

  it("never mixes in another user's sessions", async () => {
    expect(await stats.monthDays(bob, SEPTEMBER)).toEqual([
      { date: '2026-09-30', focusedMilliseconds: 90 * MIN, sessionCount: 1 },
    ]);
  });
});
