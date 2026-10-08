/**
 * Contract captures (X3, X4): a real answer made deterministic, so it can be compared byte for
 * byte with the copy the mobile repo parses. Random ids are replaced through `replace`, variation
 * seeds by stable numbers in order of appearance, and database-clock timestamps by one fixed
 * instant (they are not under the test clock).
 */

/** Database-clock fields, whose values are not under the test clock. */
const DB_TIME_KEYS = new Set(['createdAt', 'updatedAt']);
const FIXED_DB_TIME = '2026-01-01T00:00:00.000Z';

export function normalize(
  value: unknown,
  replace: Map<string, string>,
  seeds: Map<number, number>,
): unknown {
  if (typeof value === 'string') return replace.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => normalize(item, replace, seeds));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (DB_TIME_KEYS.has(key) && typeof item === 'string') return [key, FIXED_DB_TIME];
        if (key === 'variationSeed' && typeof item === 'number') {
          if (!seeds.has(item)) seeds.set(item, 1_000_001 + seeds.size);
          return [key, seeds.get(item)];
        }
        return [key, normalize(item, replace, seeds)];
      }),
    );
  }
  return value;
}
