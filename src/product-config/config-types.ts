/**
 * Building blocks for the Product configuration registry.
 * A registry maps each configuration key to its description and value type.
 */

export interface ConfigValueType<T> {
  /** Human-readable description used in error messages, e.g. "an integer ≥ 1". */
  readonly expected: string;
  is(value: unknown): value is T;
}

export interface ConfigKeyDefinition<T> {
  readonly description: string;
  readonly type: ConfigValueType<T>;
}

export type ConfigRegistry = Readonly<Record<string, ConfigKeyDefinition<unknown>>>;

export type ConfigKey<R extends ConfigRegistry> = Extract<keyof R, string>;

export type ConfigValue<R extends ConfigRegistry, K extends ConfigKey<R>> =
  R[K] extends ConfigKeyDefinition<infer T> ? T : never;

export function integer(bounds: { min?: number; max?: number } = {}): ConfigValueType<number> {
  const { min, max } = bounds;
  let expected = 'an integer';
  if (min !== undefined && max !== undefined) expected = `an integer from ${min} to ${max}`;
  else if (min !== undefined) expected = `an integer ≥ ${min}`;
  else if (max !== undefined) expected = `an integer ≤ ${max}`;

  return {
    expected,
    is: (value): value is number =>
      Number.isInteger(value) &&
      (min === undefined || (value as number) >= min) &&
      (max === undefined || (value as number) <= max),
  };
}

export function boolean(): ConfigValueType<boolean> {
  return { expected: 'a boolean', is: (value): value is boolean => typeof value === 'boolean' };
}

export function list<T>(item: ConfigValueType<T>): ConfigValueType<readonly T[]> {
  return {
    expected: `a list of ${item.expected}`,
    is: (value): value is readonly T[] =>
      Array.isArray(value) && value.every((entry) => item.is(entry)),
  };
}

/** Returns one problem description per invalid, missing, or unknown key. */
export function findConfigProblems(
  registry: ConfigRegistry,
  values: Readonly<Record<string, unknown>>,
): string[] {
  const problems: string[] = [];
  for (const [key, definition] of Object.entries(registry)) {
    if (!Object.hasOwn(values, key)) {
      problems.push(`"${key}" is missing`);
    } else if (!definition.type.is(values[key])) {
      problems.push(
        `"${key}" must be ${definition.type.expected}, got ${describeValue(values[key])}`,
      );
    }
  }
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(registry, key)) problems.push(`"${key}" is an unknown key`);
  }
  return problems;
}

export function describeValue(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}
