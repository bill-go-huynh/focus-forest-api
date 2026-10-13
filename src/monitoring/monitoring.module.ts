import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { AdminClientErrorsController, ClientErrorsController } from './client-errors.controller.js';
import { ClientErrorsService } from './client-errors.service.js';

/**
 * A7.4 Error monitoring, self-built (owner decision 1): crash and error reports from the apps.
 * The request id middleware and the server error filter are set up in `configureApp`.
 */
@Module({
  imports: [JobsModule, AdminModule],
  controllers: [ClientErrorsController, AdminClientErrorsController],
  providers: [ClientErrorsService],
})
export class MonitoringModule {}
