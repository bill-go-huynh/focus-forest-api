import { Module } from '@nestjs/common';

import { MonthAttributionService } from './month-attribution.service.js';

/** Month and day attribution (docs/06_DOMAIN_MODEL.md → Time and attribution). */
@Module({
  providers: [MonthAttributionService],
  exports: [MonthAttributionService],
})
export class AttributionModule {}
