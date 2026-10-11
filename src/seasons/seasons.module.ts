import { Module } from '@nestjs/common';

import { ProgressionModule } from '../progression/progression.module.js';
import { SeasonsController } from './seasons.controller.js';
import { SeasonsService } from './seasons.service.js';

/** A5.9 Seasonal content. Sessions use it; it never imports Sessions. */
@Module({
  imports: [ProgressionModule],
  controllers: [SeasonsController],
  providers: [SeasonsService],
  exports: [SeasonsService],
})
export class SeasonsModule {}
