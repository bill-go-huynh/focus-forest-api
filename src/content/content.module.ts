import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module.js';
import { LeaderboardsModule } from '../leaderboards/leaderboards.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { LiveController } from './live.controller.js';
import { LiveService } from './live.service.js';

/**
 * The admin content tools: the catalog (A6.4: badges, achievements, species, cosmetics) and live
 * operations (A6.5: events, seasonal themes, leaderboards).
 */
@Module({
  imports: [AdminModule, LeaderboardsModule],
  controllers: [CatalogController, LiveController],
  providers: [CatalogService, LiveService],
})
export class ContentModule {}
