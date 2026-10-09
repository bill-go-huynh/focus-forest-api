import { Module } from '@nestjs/common';

import { PrivacyService } from './privacy.service.js';
import { SocialGraphService } from './social-graph.service.js';
import { ReactionsService } from './reactions.service.js';
import {
  PrivacyController,
  ReactionsReceivedController,
  SocialGraphController,
  UsersController,
} from './social.controller.js';
import { VisibilityService } from './visibility.service.js';

/**
 * Social (A5.1–A5.2): the follow graph, blocks, privacy, reactions, and the visibility gate that
 * every cross-user read goes through.
 */
@Module({
  controllers: [
    UsersController,
    SocialGraphController,
    PrivacyController,
    ReactionsReceivedController,
  ],
  providers: [SocialGraphService, PrivacyService, VisibilityService, ReactionsService],
  exports: [VisibilityService, ReactionsService],
})
export class SocialModule {}
