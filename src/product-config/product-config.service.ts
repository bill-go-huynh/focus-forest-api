import { Inject, Injectable } from '@nestjs/common';

import { findConfigProblems, type ConfigRegistry } from './config-types.js';
import {
  ConfigVersionNotFoundError,
  InvalidConfigVersionError,
  NoActiveConfigVersionError,
} from './product-config.errors.js';
import { PRODUCT_CONFIG_REGISTRY, type ProductConfigRegistry } from './product-config.registry.js';
import { ProductConfigRepository, type StoredConfigVersion } from './product-config.repository.js';
import { ProductConfig } from './product-config.js';

/**
 * The single entry point for Product configuration. Domain code injects this
 * service and never reads the configuration tables directly.
 */
@Injectable()
export class ProductConfigService<R extends ConfigRegistry = ProductConfigRegistry> {
  constructor(
    private readonly repository: ProductConfigRepository,
    @Inject(PRODUCT_CONFIG_REGISTRY) private readonly registry: R,
  ) {}

  /** The active version. Record `version` with anything computed from it. */
  async active(): Promise<ProductConfig<R>> {
    const stored = await this.repository.findActiveVersion();
    if (!stored) throw new NoActiveConfigVersionError();
    return this.toConfig(stored);
  }

  /** Any stored version, for example the one an archived result was computed with. */
  async version(version: number): Promise<ProductConfig<R>> {
    return this.toConfig(await this.findOrThrow(version));
  }

  /** Stores a new version. It must define every registry key, with valid values. */
  async createVersion(
    values: Readonly<Record<string, unknown>>,
    note: string,
  ): Promise<ProductConfig<R>> {
    const problems = findConfigProblems(this.registry, values);
    if (problems.length > 0) throw new InvalidConfigVersionError(problems);
    return this.toConfig(await this.repository.createVersion(values, note));
  }

  /** Makes a stored version active, if it is complete and valid for the current registry. */
  async activate(version: number): Promise<void> {
    const stored = await this.findOrThrow(version);
    const problems = findConfigProblems(this.registry, stored.values);
    if (problems.length > 0) throw new InvalidConfigVersionError(problems, version);
    await this.repository.setActiveVersion(version);
  }

  private async findOrThrow(version: number): Promise<StoredConfigVersion> {
    const stored = await this.repository.findVersion(version);
    if (!stored) throw new ConfigVersionNotFoundError(version);
    return stored;
  }

  private toConfig(stored: StoredConfigVersion): ProductConfig<R> {
    return new ProductConfig(stored.version, stored.values, this.registry);
  }
}
