import { Module } from '@nestjs/common';

import { ProgressionOwnershipService } from './progression-ownership.service.js';

/**
 * The progression foundation (Phase 4, A4.1): content definitions (seed data) and permanent
 * ownership. No endpoints yet: achievements (A4.2), species and cosmetics (A4.3), and the
 * collection (A4.4) build on it.
 */
@Module({
  providers: [ProgressionOwnershipService],
  exports: [ProgressionOwnershipService],
})
export class ProgressionModule {}
