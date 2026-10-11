import { JobsService } from '../../src/jobs/jobs.service.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A6.1 background jobs (docs/08 §6: a Postgres-backed queue): due jobs run once, even with
 * several runners; failures retry with backoff and give up after five attempts; a dedupe key
 * makes scheduling idempotent.
 */

const t = new ConsistencyHarness('2026-11-02T10:00:00.000Z');
const at = (iso: string) => new Date(iso);
const MIN = 60_000;

describe('jobs (A6.1)', () => {
  let jobs: JobsService;
  const ran: { kind: string; payload: unknown; now: Date }[] = [];
  let failures = 0;

  beforeAll(async () => {
    await t.start();
    jobs = t.app.get(JobsService);
    jobs.register('test.record', (payload, context) => {
      ran.push({ kind: 'test.record', payload, now: context.now });
      return Promise.resolve();
    });
    jobs.register('test.flaky', () => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('not yet'));
      }
      ran.push({ kind: 'test.flaky', payload: null, now: at('2000-01-01T00:00:00Z') });
      return Promise.resolve();
    });
  });
  afterAll(() => t.stop());
  beforeEach(() => {
    t.reset();
    ran.length = 0;
    failures = 0;
  });

  it('runs due jobs once, in run order, and leaves later ones', async () => {
    await jobs.enqueue(t.prisma, {
      kind: 'test.record',
      runAt: at('2026-11-02T09:30:00Z'),
      payload: { n: 2 },
    });
    await jobs.enqueue(t.prisma, {
      kind: 'test.record',
      runAt: at('2026-11-02T09:00:00Z'),
      payload: { n: 1 },
    });
    await jobs.enqueue(t.prisma, {
      kind: 'test.record',
      runAt: at('2026-11-02T11:00:00Z'),
      payload: { n: 3 },
    });

    expect(await jobs.runDue(at('2026-11-02T10:00:00Z'))).toEqual({ ran: 2, failed: 0 });
    expect(ran.map((r) => r.payload)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(ran[0]!.now).toEqual(at('2026-11-02T10:00:00Z'));

    expect(await jobs.runDue(at('2026-11-02T10:30:00Z'))).toEqual({ ran: 0, failed: 0 });
    expect(await jobs.runDue(at('2026-11-02T11:00:00Z'))).toEqual({ ran: 1, failed: 0 });
    expect(ran.map((r) => r.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('schedules a job with a dedupe key once', async () => {
    const job = { kind: 'test.record', runAt: at('2026-11-02T09:00:00Z'), payload: {} };
    expect(await jobs.enqueue(t.prisma, { ...job, dedupeKey: 'once' })).toBe(true);
    expect(await jobs.enqueue(t.prisma, { ...job, dedupeKey: 'once' })).toBe(false);
    expect(await jobs.enqueue(t.prisma, job)).toBe(true);
    expect(await t.prisma.job.count()).toBe(2);
  });

  it('enqueues inside the caller’s transaction', async () => {
    await expect(
      t.prisma.$transaction(async (tx) => {
        await jobs.enqueue(tx, {
          kind: 'test.record',
          runAt: at('2026-11-02T09:00:00Z'),
          payload: {},
        });
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await t.prisma.job.count()).toBe(0);
  });

  it('retries a failing job with growing waits, and succeeds later', async () => {
    failures = 2;
    await jobs.enqueue(t.prisma, {
      kind: 'test.flaky',
      runAt: at('2026-11-02T10:00:00Z'),
      payload: {},
    });

    expect(await jobs.runDue(at('2026-11-02T10:00:00Z'))).toEqual({ ran: 0, failed: 1 });
    const first = await t.prisma.job.findFirstOrThrow();
    expect(first).toMatchObject({ attempts: 1, lastError: 'not yet', completedAt: null });
    expect(first.runAt).toEqual(new Date(at('2026-11-02T10:00:00Z').getTime() + 1 * MIN));

    expect(await jobs.runDue(at('2026-11-02T10:00:30Z'))).toEqual({ ran: 0, failed: 0 });
    expect(await jobs.runDue(at('2026-11-02T10:01:00Z'))).toEqual({ ran: 0, failed: 1 });
    expect((await t.prisma.job.findFirstOrThrow()).runAt).toEqual(
      new Date(at('2026-11-02T10:01:00Z').getTime() + 5 * MIN),
    );

    expect(await jobs.runDue(at('2026-11-02T10:06:00Z'))).toEqual({ ran: 1, failed: 0 });
    expect(await t.prisma.job.findFirstOrThrow()).toMatchObject({
      attempts: 3,
      completedAt: at('2026-11-02T10:06:00Z'),
      failedAt: null,
    });
  });

  it('gives up after five attempts and keeps the reason', async () => {
    failures = 99;
    await jobs.enqueue(t.prisma, {
      kind: 'test.flaky',
      runAt: at('2026-11-02T10:00:00Z'),
      payload: {},
    });
    let now = at('2026-11-02T10:00:00Z').getTime();
    for (let i = 0; i < 5; i += 1) {
      await jobs.runDue(new Date(now));
      now += 24 * 60 * MIN;
    }
    expect(await t.prisma.job.findFirstOrThrow()).toMatchObject({
      attempts: 5,
      lastError: 'not yet',
      failedAt: expect.any(Date) as Date,
      completedAt: null,
    });
    expect(await jobs.runDue(new Date(now))).toEqual({ ran: 0, failed: 0 });
  });

  it('fails a job nobody handles, without retrying it', async () => {
    await jobs.enqueue(t.prisma, {
      kind: 'test.unknown',
      runAt: at('2026-11-02T10:00:00Z'),
      payload: {},
    });
    expect(await jobs.runDue(at('2026-11-02T10:00:00Z'))).toEqual({ ran: 0, failed: 1 });
    expect(await t.prisma.job.findFirstOrThrow()).toMatchObject({
      attempts: 1,
      failedAt: at('2026-11-02T10:00:00Z'),
      lastError: 'No handler for test.unknown.',
    });
  });

  it('runs each job once when several runners poll at the same time', async () => {
    for (let n = 0; n < 20; n += 1) {
      await jobs.enqueue(t.prisma, {
        kind: 'test.record',
        runAt: at('2026-11-02T09:00:00Z'),
        payload: { n },
      });
    }
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => jobs.runDue(at('2026-11-02T10:00:00Z'))),
    );
    expect(results.reduce((sum, r) => sum + r.ran, 0)).toBe(20);
    expect(new Set(ran.map((r) => JSON.stringify(r.payload))).size).toBe(20);
    expect(ran).toHaveLength(20);
  });
});
