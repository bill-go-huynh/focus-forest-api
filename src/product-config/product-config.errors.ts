export class ProductConfigError extends Error {
  override name = 'ProductConfigError';
}

export class UnknownConfigKeyError extends ProductConfigError {
  override name = 'UnknownConfigKeyError';

  constructor(readonly key: string) {
    super(`Unknown product configuration key "${key}".`);
  }
}

export class MissingConfigValueError extends ProductConfigError {
  override name = 'MissingConfigValueError';

  constructor(
    readonly key: string,
    readonly version: number,
  ) {
    super(`Product configuration "${key}" has no value in version ${version}.`);
  }
}

export class InvalidConfigValueError extends ProductConfigError {
  override name = 'InvalidConfigValueError';

  constructor(
    readonly key: string,
    readonly version: number,
    detail: string,
  ) {
    super(`Product configuration "${key}" in version ${version} ${detail}.`);
  }
}

export class InvalidConfigVersionError extends ProductConfigError {
  override name = 'InvalidConfigVersionError';

  constructor(
    readonly problems: readonly string[],
    version?: number,
  ) {
    const target =
      version === undefined
        ? 'New product configuration'
        : `Product configuration version ${version}`;
    super(`${target} is invalid: ${problems.join('; ')}.`);
  }
}

export class ConfigVersionNotFoundError extends ProductConfigError {
  override name = 'ConfigVersionNotFoundError';

  constructor(readonly version: number) {
    super(`Product configuration version ${version} does not exist.`);
  }
}

export class NoActiveConfigVersionError extends ProductConfigError {
  override name = 'NoActiveConfigVersionError';

  constructor() {
    super('No product configuration version is active.');
  }
}
