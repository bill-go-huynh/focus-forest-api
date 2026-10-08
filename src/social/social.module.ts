import { Module } from '@nestjs/common';

import { PrivacyService } from './privacy.service.js';
import { SocialGraphService } from './social-graph.service.js';
import { PrivacyController, SocialGraphController, UsersController } from './social.controller.js';
import { VisibilityService } from './visibility.service.js';

/** A5.1 Social: the follow graph, blocks, privacy, and the visibility gate for later modules. */
@Module({
  controllers: [UsersController, SocialGraphController, PrivacyController],
  providers: [SocialGraphService, PrivacyService, VisibilityService],
  exports: [VisibilityService],
})
export class SocialModule {}
