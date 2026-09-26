import {
  describeValue,
  type ConfigKey,
  type ConfigRegistry,
  type ConfigValue,
} from './config-types.js';
import {
  InvalidConfigValueError,
  MissingConfigValueError,
  UnknownConfigKeyError,
} from './product-config.errors.js';

/**
 * The values of one configuration version. Every value read from one instance
 * comes from the same version, so a computation never mixes versions.
 */
export class ProductConfig<R extends ConfigRegistry> {
  private readonly values: Readonly<Record<string, unknown>>;

  constructor(
    readonly version: number,
    values: Readonly<Record<string, unknown>>,
    private readonly registry: R,
  ) {
    this.values = deepFreeze(structuredClone(values));
  }

  get<K extends ConfigKey<R>>(key: K): ConfigValue<R, K> {
    if (!Object.hasOwn(this.registry, key)) throw new UnknownConfigKeyError(key);
    if (!Object.hasOwn(this.values, key)) throw new MissingConfigValueError(key, this.version);

    const definition = this.registry[key];
    const value = this.values[key];
    if (!definition?.type.is(value)) {
      throw new InvalidConfigValueError(
        key,
        this.version,
        `must be ${definition?.type.expected ?? 'valid'}, got ${describeValue(value)}`,
      );
    }
    return value as ConfigValue<R, K>;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
