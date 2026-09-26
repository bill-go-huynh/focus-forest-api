import { Module } from '@nestjs/common';

import { PRODUCT_CONFIG_REGISTRY, productConfigRegistry } from './product-config.registry.js';
import { ProductConfigRepository } from './product-config.repository.js';
import { ProductConfigService } from './product-config.service.js';

@Module({
  providers: [
    ProductConfigRepository,
    ProductConfigService,
    { provide: PRODUCT_CONFIG_REGISTRY, useValue: productConfigRegistry },
  ],
  exports: [ProductConfigService],
})
export class ProductConfigModule {}
