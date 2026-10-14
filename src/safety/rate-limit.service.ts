import { createHash } from 'node:crypto';

import { HttpException, HttpStatus, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../config/env.validation.js';
import { JobsService } from '../jobs/jobs.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { RATE_LIMIT_NAMES, type RateLimitKey, type RateLimitName } from './rate-limit.decorator.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const PRUNE_JOB = 'rateLimits.prune';

/** A refusal: when the window ends, for the `Retry-After` header and the body. */
export class RateLimitedException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: 'Too many attempts. Please wait a little and try again.',
        code: 'rate_limited',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * A7.2 Fixed-window rate limits in Postgres (Phase 7 owner decision 2: no dependency, correct
 * across API instances). One statement counts a hit and reads the total. Keys are hashed: the
 * table holds no address or email. Windows older than a day are pruned every hour.
 */
@Injectable()
export class RateLimitService implements OnModuleInit {
  /** `RATE_LIMITS=off` (the integration tests) counts nothing; the rate-limit test sets it. */
  enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly jobs: JobsService,
    env: ConfigService<EnvironmentVariables, true>,
  ) {
    this.enabled = env.get('RATE_LIMITS', { infer: true }) === 'on';
  }

  onModuleInit(): void {
    this.jobs.registerRecurring(PRUNE_JOB, HOUR, (slot) => this.prune(slot));
  }

  /** Counts one hit; throws `RateLimitedException` once the window's hits pass the limit. */
  async hit(name: RateLimitName, key: RateLimitKey, value: string, now: Date): Promise<void> {
    if (!this.enabled) return;
    const { limit, windowSeconds } = (await this.config.active()).get(`rateLimit.${name}`);
    const windowMs = windowSeconds * 1000;
    const start = Math.floor(now.getTime() / windowMs) * windowMs;
    const bucket = `${name}:${key}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
    const [row] = await this.prisma.$queryRaw<{ hits: number }[]>`
      INSERT INTO "rate_limit_windows" ("bucket", "window_start", "hits")
      VALUES (${bucket}, ${new Date(start)}, 1)
      ON CONFLICT ("bucket", "window_start")
      DO UPDATE SET "hits" = "rate_limit_windows"."hits" + 1
      RETURNING "hits"`;
    if ((row?.hits ?? 0) > limit) {
      throw new RateLimitedException(Math.ceil((start + windowMs - now.getTime()) / 1000));
    }
  }

  /**
   * D7.1 Per limit, over the day before `now`: requests refused (hits past the limit in each
   * window) and how many keys were refused. Counts only: buckets are hashed.
   */
  async refusals(now: Date): Promise<{
    since: string;
    items: { name: RateLimitName; limit: number; refused: number; keys: number }[];
  }> {
    const since = new Date(now.getTime() - DAY);
    const active = await this.config.active();
    const rows = await this.prisma.rateLimitWindow.findMany({
      where: { windowStart: { gte: since } },
      select: { bucket: true, hits: true },
    });
    const items = RATE_LIMIT_NAMES.map((name) => {
      const { limit } = active.get(`rateLimit.${name}`);
      const over = rows.filter((row) => row.bucket.startsWith(`${name}:`) && row.hits > limit);
      return {
        name,
        limit,
        refused: over.reduce((sum, row) => sum + row.hits - limit, 0),
        keys: new Set(over.map((row) => row.bucket)).size,
      };
    });
    items.sort((a, b) => b.refused - a.refused || a.name.localeCompare(b.name));
    return { since: since.toISOString(), items };
  }

  /** Removes windows that started more than a day before `slot`. */
  async prune(slot: Date): Promise<number> {
    const { count } = await this.prisma.rateLimitWindow.deleteMany({
      where: { windowStart: { lt: new Date(slot.getTime() - DAY) } },
    });
    return count;
  }
}
