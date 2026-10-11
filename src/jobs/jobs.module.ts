import { Module } from '@nestjs/common';

import { JobsService } from './jobs.service.js';

/** A6.1 background jobs: modules register handlers and schedule work; the worker runs it. */
@Module({
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
