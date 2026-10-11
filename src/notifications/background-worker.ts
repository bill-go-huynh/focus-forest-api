import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Clock } from '../common/clock.js';
import { type EnvironmentVariables, NodeEnv } from '../config/env.validation.js';
import { JobsService } from '../jobs/jobs.service.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Polls for due jobs and notifications every `JOBS_POLL_SECONDS` (A6.1). Off in tests, which
 * call `tick` on the fixed clock, and off with `JOBS_POLL_SECONDS=0`.
 */
@Injectable()
export class BackgroundWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BackgroundWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly clock: Clock,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.config.get('JOBS_POLL_SECONDS', { infer: true });
    if (this.config.get('NODE_ENV', { infer: true }) === NodeEnv.Test || seconds === 0) return;
    this.timer = setInterval(() => void this.poll(), seconds * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One round: due jobs first (they may produce notifications), then due notifications. */
  async tick(now: Date): Promise<void> {
    await this.jobs.runDue(now);
    await this.notifications.dispatchDue(now);
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tick(this.clock.now());
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
  }
}
