/**
 * What the admin may write to the content catalog (A6.4; docs/09 later admin: badges and
 * achievements, tree variants, cosmetics). Pure: it reads a request body and the row it would
 * produce, and says every reason it would be refused, in words the admin can act on.
 *
 * - Ids are slugs (an optional `:part`), chosen once and never changed.
 * - The source is chosen once. System content is owned by everyone, so only a release defines it.
 * - New content starts planned or active; it is retired later, never deleted once owned.
 * - A limited window has an end, after its start; permanent content has no end.
 * - Achievement-sourced species and cosmetics name the achievement that unlocks them.
 */

export const CATALOG_KINDS = ['badges', 'achievements', 'species', 'cosmetics'] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

const RARITIES = ['common', 'rare', 'legendary'] as const;
const STATUSES = ['planned', 'active', 'retired'] as const;
const AVAILABILITIES = ['permanent', 'limited'] as const;
const ADMIN_SOURCES = ['achievement', 'season'] as const;
const BADGE_CATEGORIES = ['focus', 'consistency', 'time_based', 'social', 'event', 'rare'] as const;
const COSMETIC_TYPES = [
  'background',
  'decoration',
  'fauna',
  'weather',
  'profile_frame',
  'effect',
] as const;
const CRITERIA = [
  'counted_sessions',
  'focused_minutes',
  'longest_streak_days',
  'focus_together_sessions',
  'focus_together_with_friend',
  'sessions_before_7',
  'sessions_after_22',
  'full_weekends',
] as const;

type Field =
  | { kind: 'id' }
  | { kind: 'ref'; nullable?: boolean }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'text'; max: number }
  | { kind: 'artwork' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'bool' }
  | { kind: 'instant' };

const ID = /^[a-z0-9]+(-[a-z0-9]+)*(:[a-z0-9]+(-[a-z0-9]+)*)?$/;
const ARTWORK = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const COMMON: Record<string, Field> = {
  rarity: { kind: 'enum', values: RARITIES },
  availability: { kind: 'enum', values: AVAILABILITIES },
  availableFrom: { kind: 'instant' },
  availableUntil: { kind: 'instant' },
  status: { kind: 'enum', values: STATUSES },
  name: { kind: 'text', max: 60 },
  description: { kind: 'text', max: 280 },
  sortOrder: { kind: 'int', min: 0, max: 100_000 },
};

/** Every field of a new item, and the ones an edit may change. */
export const CATALOG_FIELDS: Record<
  CatalogKind,
  { create: Record<string, Field>; editable: string[] }
> = {
  badges: {
    create: {
      id: { kind: 'id' },
      category: { kind: 'enum', values: BADGE_CATEGORIES },
      source: { kind: 'enum', values: ADMIN_SOURCES },
      artworkId: { kind: 'artwork' },
      ...COMMON,
    },
    editable: [
      'category',
      'artworkId',
      'rarity',
      'availability',
      'availableFrom',
      'availableUntil',
      'status',
      'name',
      'description',
      'sortOrder',
    ],
  },
  achievements: {
    create: {
      id: { kind: 'id' },
      badgeId: { kind: 'ref' },
      criterion: { kind: 'enum', values: CRITERIA },
      target: { kind: 'int', min: 1, max: 1_000_000 },
      progressVisible: { kind: 'bool' },
    },
    editable: ['criterion', 'target', 'progressVisible'],
  },
  species: {
    create: {
      id: { kind: 'id' },
      baseSpeciesId: { kind: 'ref', nullable: true },
      source: { kind: 'enum', values: ADMIN_SOURCES },
      achievementId: { kind: 'ref', nullable: true },
      ...COMMON,
    },
    editable: [
      'achievementId',
      'rarity',
      'availability',
      'availableFrom',
      'availableUntil',
      'status',
      'name',
      'description',
      'sortOrder',
    ],
  },
  cosmetics: {
    create: {
      id: { kind: 'id' },
      type: { kind: 'enum', values: COSMETIC_TYPES },
      source: { kind: 'enum', values: ADMIN_SOURCES },
      achievementId: { kind: 'ref', nullable: true },
      artworkId: { kind: 'artwork' },
      ...COMMON,
    },
    editable: [
      'achievementId',
      'artworkId',
      'rarity',
      'availability',
      'availableFrom',
      'availableUntil',
      'status',
      'name',
      'description',
      'sortOrder',
    ],
  },
};

export type CatalogValues = Record<string, string | number | boolean | null>;

function fieldProblem(name: string, field: Field, value: unknown): string | null {
  const isNull = value === null;
  switch (field.kind) {
    case 'id':
      return typeof value === 'string' && ID.test(value)
        ? null
        : `${name} must be lowercase words joined by "-", with an optional ":part".`;
    case 'ref':
      if (isNull && field.nullable) return null;
      return typeof value === 'string' && ID.test(value) ? null : `${name} must name an item.`;
    case 'enum':
      return typeof value === 'string' && field.values.includes(value)
        ? null
        : `${name} must be one of: ${field.values.join(', ')}.`;
    case 'text':
      return typeof value === 'string' && value.trim() !== '' && value.trim().length <= field.max
        ? null
        : `${name} must be text of 1 to ${field.max} characters.`;
    case 'artwork':
      return typeof value === 'string' && ARTWORK.test(value)
        ? null
        : `${name} must be lowercase words joined by "-".`;
    case 'int':
      return typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= field.min &&
        value <= field.max
        ? null
        : `${name} must be a whole number from ${field.min} to ${field.max}.`;
    case 'bool':
      return typeof value === 'boolean' ? null : `${name} must be true or false.`;
    case 'instant':
      return isNull ||
        (typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value)))
        ? null
        : `${name} must be an ISO 8601 UTC instant or null.`;
  }
}

/** The reasons a request body would be refused, and its values (texts trimmed). */
export function bodyProblems(
  kind: CatalogKind,
  mode: 'create' | 'update',
  body: Record<string, unknown>,
): { problems: string[]; values: CatalogValues } {
  const { create, editable } = CATALOG_FIELDS[kind];
  const problems: string[] = [];
  const values: CatalogValues = {};
  const reason = body['reason'];
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
    problems.push('reason must say why, in 3 to 500 characters.');
  }
  for (const [name, value] of Object.entries(body)) {
    if (name === 'reason') continue;
    const field = create[name];
    if (!field) {
      problems.push(`${name} is not a field of ${kind}.`);
      continue;
    }
    if (mode === 'update' && !editable.includes(name)) {
      problems.push(`${name} cannot be changed once created.`);
      continue;
    }
    const problem = fieldProblem(name, field, value);
    if (problem) problems.push(problem);
    else values[name] = typeof value === 'string' ? value.trim() : (value as CatalogValues[string]);
  }
  if (mode === 'create') {
    for (const name of Object.keys(create)) {
      if (!(name in body)) problems.push(`${name} is required.`);
    }
    if (values['status'] === 'retired')
      problems.push('status of new content is planned or active.');
  } else if (Object.keys(values).length === 0 && problems.length === 0) {
    problems.push('Change at least one field.');
  }
  return { problems, values };
}

/** The reasons the resulting item would be refused, whatever the request. */
export function rowProblems(kind: CatalogKind, row: CatalogValues): string[] {
  const problems: string[] = [];
  if (kind === 'achievements') return problems;
  const from = row['availableFrom'];
  const until = row['availableUntil'];
  if (row['availability'] === 'limited' && until === null) {
    problems.push('availableUntil is required for limited content.');
  }
  if (row['availability'] === 'permanent' && until !== null) {
    problems.push('availableUntil must be null for permanent content.');
  }
  if (
    typeof from === 'string' &&
    typeof until === 'string' &&
    Date.parse(from) >= Date.parse(until)
  ) {
    problems.push('availableFrom must be before availableUntil.');
  }
  if (kind === 'species' || kind === 'cosmetics') {
    const named = row['achievementId'] !== null && row['achievementId'] !== undefined;
    if ((row['source'] === 'achievement') !== named) {
      problems.push(
        'achievementId names the unlocking achievement exactly when the source is achievement.',
      );
    }
  }
  return problems;
}
