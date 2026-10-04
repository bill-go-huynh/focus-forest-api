import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { Clock, FixedClock } from '../../src/common/clock.js';
import { addDays, type LocalDate } from '../../src/common/local-date.js';
import type { FocusSessionStatus } from '../../src/generated/prisma/client.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { ProductConfigService } from '../../src/product-config/product-config.service.js';
import { listenOnLoopback } from './loopback-http.js';
import { configValues } from './product-config-values.js';
import { countingPrismaClient, QueryCounter } from './query-counter.js';

const MIN = 60_000;

/**
 * An app for goals, rest days, and streak tests: a fixed clock, a configuration version
 * activated before each test, and helpers that sign users up and store counted focus directly.
 */
export class ConsistencyHarness {
  app!: INestApplication<App>;
  url!: string;
  prisma!: PrismaService;
  readonly clock: FixedClock;
  /** With `countQueries`: the statements the app sent. */
  readonly queries = new QueryCounter();
  /** Signed-up users, so their access tokens can be renewed when the clock moves. */
  private readonly users: { email: string; auth: Record<string, string> }[] = [];

  constructor(
    now: string,
    private readonly options: { countQueries?: boolean } = {},
  ) {
    this.clock = new FixedClock(new Date(now));
  }

  async start(): Promise<void> {
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ cost: 2 ** 10 }))
      .overrideProvider(Clock)
      .useValue(this.clock);
    if (this.options.countQueries) {
      const url = process.env['DATABASE_URL'] ?? '';
      builder = builder
        .overrideProvider(PrismaService)
        .useValue(countingPrismaClient(url, this.queries));
    }
    const moduleRef = await builder.compile();
    this.app = moduleRef.createNestApplication();
    configureApp(this.app);
    this.url = await listenOnLoopback(this.app);
    this.prisma = this.app.get(PrismaService);
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  /** Every test starts with empty tables, configuration included. */
  async activateConfig(overrides: Record<string, unknown> = {}): Promise<void> {
    const config = this.app.get(ProductConfigService);
    const created = await config.createVersion(configValues(overrides), 'test');
    await config.activate(created.version);
  }

  http() {
    return request(this.url);
  }

  /**
   * `joinedAt` replaces the join date (users.created_at, set by the database clock, not the
   * test clock), so first-month proration is deterministic.
   */
  async signUp(
    email: string,
    timezone: string | null = 'UTC',
    joinedAt = '2026-01-01T00:00:00.000Z',
  ) {
    const res = await this.http()
      .post('/auth/sign-up')
      .send({ email, password: 'correct horse battery staple' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    const auth: Record<string, string> = { Authorization: `Bearer ${body.accessToken}` };
    this.users.push({ email, auth });
    if (timezone) await this.http().patch('/me/profile').set(auth).send({ timezone }).expect(200);
    await this.prisma.user.update({
      where: { id: body.user.id },
      data: { createdAt: new Date(joinedAt) },
    });
    const topic = await this.prisma.topic.create({
      data: {
        id: randomUUID(),
        userId: body.user.id,
        name: 'Reading',
        icon: 'book',
        color: 'topic.1',
        createFingerprint: 'test',
      },
    });
    return { userId: body.user.id, auth, topicId: topic.id };
  }

  /** Stores one session per entry on its local date (UTC month contexts), as the server would. */
  async focus(
    user: { userId: string; topicId: string },
    sessions: [date: LocalDate, minutes: number, status?: FocusSessionStatus][],
  ): Promise<void> {
    for (const [date, minutes, status = 'completed'] of sessions) {
      const [year = 0, month = 1] = date.split('-').map(Number);
      await this.prisma.monthAttributionContext.upsert({
        where: { userId_year_month: { userId: user.userId, year, month } },
        update: {},
        create: {
          userId: user.userId,
          year,
          month,
          timezone: 'UTC',
          startsAt: new Date(Date.UTC(year, month - 1, 1)),
          endsAt: new Date(Date.UTC(year, month, 1)),
        },
      });
      const startedAt = new Date(`${date}T08:00:00.000Z`);
      const endedAt = new Date(startedAt.getTime() + minutes * MIN);
      await this.prisma.focusSession.create({
        data: {
          id: randomUUID(),
          userId: user.userId,
          topicId: user.topicId,
          startedAt,
          submittedEndedAt: endedAt,
          plannedMinutes: Math.max(1, minutes),
          pauseIntervals: [],
          effectiveEndedAt: endedAt,
          focusedMilliseconds: minutes * MIN,
          pausedMilliseconds: 0,
          status,
          localDate: new Date(`${date}T00:00:00.000Z`),
          year,
          month,
          configVersion: 4,
        },
      });
    }
  }

  /**
   * Submits a session through PUT /me/sessions/:id, as the app does: `minutes` of focus from
   * `startedAt`, without pauses. Returns the response; the clock must be past the end.
   */
  submit(
    user: { auth: Record<string, string>; topicId: string },
    startedAt: string,
    minutes: number,
    id: string = randomUUID(),
  ) {
    const start = new Date(startedAt);
    return this.http()
      .put(`/me/sessions/${id}`)
      .set(user.auth)
      .send({
        topicId: user.topicId,
        startedAt: start.toISOString(),
        endedAt: new Date(start.getTime() + minutes * MIN).toISOString(),
        plannedMinutes: Math.max(1, Math.ceil(minutes)),
        pauseIntervals: [],
      });
  }

  /** Moves the clock to 12:00 UTC on a date. */
  async setToday(date: LocalDate): Promise<void> {
    await this.setNow(`${date}T12:00:00.000Z`);
  }

  /** Moves the clock and renews every user's access token, which would have expired. */
  async setNow(iso: string): Promise<void> {
    this.clock.set(new Date(iso));
    for (const user of this.users) {
      const res = await this.http()
        .post('/auth/sign-in')
        .send({ email: user.email, password: 'correct horse battery staple' })
        .expect(200);
      user.auth['Authorization'] = `Bearer ${(res.body as { accessToken: string }).accessToken}`;
    }
  }

  /** Forgets the users of the previous test (tables are emptied between tests). */
  reset(): void {
    this.users.length = 0;
  }
}

/** Consecutive dates starting at `from`. */
export const dateRange = (from: LocalDate, count: number): LocalDate[] =>
  Array.from({ length: count }, (_, index) => addDays(from, index));
