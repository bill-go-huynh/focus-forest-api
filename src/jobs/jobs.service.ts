import { Injectable } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Background jobs on PostgreSQL (docs/08 §6: "start with a Postgres-backed job queue"). A job is
 * claimed with `FOR UPDATE SKIP LOCKED` and a lock time, so several API instances never run it
 * twice. A failure is retried after 1, 5, 30, and 120 minutes; the fifth failure gives it up
 * (`failed_at`), with the last error kept. Time is always passed in: tests run jobs on the fixed clock.
 */

export interface JobContext {
  now: Date;
  jobId: bigint;
}
export type JobHandler = (payload: unknown, context: JobContext) => Promise<void>;

export interface NewJob {
  kind: string;
  runAt: Date;
  payload: unknown;
  /** Scheduling the same key again does nothing. */
  dedupeKey?: string;
}

type Db = Prisma.TransactionClient;

/** The wait before each retry; a failure with no wait left gives the job up. */
const BACKOFF_MINUTES = [1, 5, 30, 120];
const LOCK_MS = 5 * 60_000;
const MIN = 60_000;

interface ClaimedJob {
  id: bigint;
  kind: string;
  payload: unknown;
  attempts: number;
}

@Injectable()
export class JobsService {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly recurring = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  /** Each kind has one handler, registered by the module that owns it. */
  register(kind: string, handler: JobHandler): void {
    if (this.handlers.has(kind)) throw new Error(`A handler for ${kind} is already registered.`);
    this.handlers.set(kind, handler);
  }

  /**
   * A job that runs once per period, on slots aligned to it (every quarter hour: :00, :15, …).
   * Each run handles its slot, then schedules the next one; the worker starts each chain.
   */
  registerRecurring(kind: string, periodMs: number, run: (slot: Date) => Promise<unknown>): void {
    this.recurring.set(kind, periodMs);
    this.register(kind, async (payload) => {
      const slot = new Date((payload as { slot: string }).slot);
      await run(slot);
      await this.scheduleSlot(kind, new Date(slot.getTime() + periodMs));
    });
  }

  /** Schedules each recurring job's slot holding `now` (on startup; idempotent). */
  async startRecurring(now: Date): Promise<void> {
    for (const [kind, periodMs] of this.recurring) {
      await this.scheduleSlot(kind, new Date(Math.floor(now.getTime() / periodMs) * periodMs));
    }
  }

  private scheduleSlot(kind: string, slot: Date): Promise<boolean> {
    return this.enqueue(this.prisma, {
      kind,
      runAt: slot,
      payload: { slot: slot.toISOString() },
      dedupeKey: `${kind}:${slot.toISOString()}`,
    });
  }

  /** Schedules a job, inside the caller's transaction when given one. False if the key exists. */
  async enqueue(db: Db, job: NewJob): Promise<boolean> {
    const inserted = await db.$executeRaw`
      INSERT INTO "jobs" ("kind", "payload", "run_at", "dedupe_key")
      VALUES (${job.kind}, ${JSON.stringify(job.payload ?? null)}::jsonb, ${job.runAt}, ${job.dedupeKey ?? null})
      ON CONFLICT ("dedupe_key") DO NOTHING`;
    return inserted === 1;
  }

  /** Runs the jobs due at `now`, one at a time, up to `limit`. */
  async runDue(now: Date, limit = 100): Promise<{ ran: number; failed: number }> {
    let ran = 0;
    let failed = 0;
    for (let i = 0; i < limit; i += 1) {
      const job = await this.claim(now);
      if (!job) break;
      const handler = this.handlers.get(job.kind);
      if (!handler) {
        await this.prisma.job.update({
          where: { id: job.id },
          data: { failedAt: now, lockedUntil: null, lastError: `No handler for ${job.kind}.` },
        });
        failed += 1;
        continue;
      }
      try {
        await handler(job.payload, { now, jobId: job.id });
        await this.prisma.job.update({
          where: { id: job.id },
          data: { completedAt: now, lockedUntil: null },
        });
        ran += 1;
      } catch (error) {
        failed += 1;
        const lastError = error instanceof Error ? error.message : String(error);
        const backoff = BACKOFF_MINUTES[job.attempts - 1];
        await this.prisma.job.update({
          where: { id: job.id },
          data:
            backoff === undefined
              ? { failedAt: now, lockedUntil: null, lastError }
              : { runAt: new Date(now.getTime() + backoff * MIN), lockedUntil: null, lastError },
        });
      }
    }
    return { ran, failed };
  }

  /**
   * Claims the next due job. A runner that finds the row locked skips it; one that locks it after
   * another runner's claim committed sees the claim, because PostgreSQL re-checks a locking
   * query's conditions against the newest row version.
   */
  private async claim(now: Date): Promise<ClaimedJob | null> {
    const lockedUntil = new Date(now.getTime() + LOCK_MS);
    const [job] = await this.prisma.$queryRaw<ClaimedJob[]>`
      UPDATE "jobs" SET "locked_until" = ${lockedUntil}, "attempts" = "attempts" + 1
      WHERE "id" = (
        SELECT "id" FROM "jobs"
        WHERE "completed_at" IS NULL AND "failed_at" IS NULL AND "run_at" <= ${now}
          AND ("locked_until" IS NULL OR "locked_until" <= ${now})
        ORDER BY "run_at", "id"
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "kind", "payload", "attempts"`;
    return job ?? null;
  }
}
