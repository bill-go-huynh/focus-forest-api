import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

/** A6.4 The admin content catalog (badges, achievements, species, cosmetics). */
@Module({
  imports: [AdminModule],
  controllers: [CatalogController],
  providers: [CatalogService],
})
export class ContentModule {}
