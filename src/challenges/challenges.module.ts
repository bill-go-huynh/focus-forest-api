import { Module } from '@nestjs/common';

import { ConsistencyModule } from '../consistency/consistency.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { ChallengesController, ChallengeTemplatesController } from './challenges.controller.js';
import { ChallengesService } from './challenges.service.js';

/** A5.5 Challenges: templates from the Product configuration, progress from counted sessions. */
@Module({
  imports: [ConsistencyModule, ProductConfigModule, JobsModule, NotificationsModule],
  controllers: [ChallengeTemplatesController, ChallengesController],
  providers: [ChallengesService],
})
export class ChallengesModule {}
