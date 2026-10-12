import { Module } from '@nestjs/common';

import { ConsistencyModule } from '../consistency/consistency.module.js';
import { ProductConfigModule } from '../product-config/product-config.module.js';
import { SocialModule } from '../social/social.module.js';
import { LeaderboardsController } from './leaderboards.controller.js';
import { LeaderboardsService } from './leaderboards.service.js';

/** A5.8 Leaderboards: derived on read. The admin's live operations read boards too (A6.5). */
@Module({
  imports: [ConsistencyModule, ProductConfigModule, SocialModule],
  controllers: [LeaderboardsController],
  providers: [LeaderboardsService],
  exports: [LeaderboardsService],
})
export class LeaderboardsModule {}
