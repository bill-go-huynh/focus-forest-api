import type { PackEvent, PackTheme } from './content-pack.js';

/**
 * The shape of an admin's event or theme (A6.5), before the content-pack checks judge its
 * content. Pure. Every problem names its field (`missions[1].target`), so the admin can fix it.
 */

export const LIVE_STATUSES = ['planned', 'active', 'retired'] as const;
export type LiveStatus = (typeof LIVE_STATUSES)[number];

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const MEASURES = [
  'focus_minutes',
  'sessions',
  'active_days',
  'streak_days',
  'focus_together_sessions',
] as const;
const STAGES = ['seedling', 'growing_tree', 'bloom', 'final_form'] as const;

type Check = (value: unknown, path: string, problems: string[]) => boolean;

const text =
  (max: number): Check =>
  (value, path, problems) => {
    if (typeof value === 'string' && value.trim() !== '' && value.trim().length <= max) return true;
    problems.push(`${path} must be text of 1 to ${max} characters.`);
    return false;
  };
const int =
  (min: number, max: number): Check =>
  (value, path, problems) => {
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
      return true;
    }
    problems.push(`${path} must be a whole number from ${min} to ${max}.`);
    return false;
  };
const oneOf =
  (values: readonly (string | null)[]): Check =>
  (value, path, problems) => {
    if (values.includes(value as string | null)) return true;
    problems.push(`${path} must be one of: ${values.map(String).join(', ')}.`);
    return false;
  };
const bool: Check = (value, path, problems) => {
  if (typeof value === 'boolean') return true;
  problems.push(`${path} must be true or false.`);
  return false;
};
const instant: Check = (value, path, problems) => {
  if (typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value))) return true;
  problems.push(`${path} must be an ISO 8601 UTC instant.`);
  return false;
};
/** Any string: the content-pack checks judge slugs and references with their own words. */
const word: Check = (value, path, problems) => {
  if (typeof value === 'string' && value !== '') return true;
  problems.push(`${path} must be text.`);
  return false;
};
const nullableWord: Check = (value, path, problems) =>
  value === null || word(value, path, problems);
const list =
  (fields: Record<string, Check>, max: number): Check =>
  (value, path, problems) => {
    if (!Array.isArray(value) || value.length > max) {
      problems.push(`${path} must be a list of at most ${max}.`);
      return false;
    }
    let ok = true;
    value.forEach((item, i) => {
      ok = record(fields, item, `${path}[${i}]`, problems) && ok;
    });
    return ok;
  };

function record(
  fields: Record<string, Check>,
  value: unknown,
  path: string,
  problems: string[],
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push(`${path} must be an object.`);
    return false;
  }
  let ok = true;
  for (const [name, check] of Object.entries(fields)) {
    if (!(name in value)) {
      problems.push(`${path}.${name} is required.`);
      ok = false;
    } else ok = check((value as Record<string, unknown>)[name], `${path}.${name}`, problems) && ok;
  }
  for (const name of Object.keys(value)) {
    if (!(name in fields)) {
      problems.push(`${path}.${name} is not a field.`);
      ok = false;
    }
  }
  return ok;
}

const tree: Check = (value, path, problems) =>
  value === null ||
  record(
    {
      name: text(60),
      artworkId: word,
      milestones: list(
        { stage: oneOf(STAGES), thresholdMinutes: int(1, 1_000_000_000), badgeId: word },
        STAGES.length,
      ),
    },
    value,
    path,
    problems,
  );

const EVENT_FIELDS: Record<string, Check> = {
  id: word,
  name: text(60),
  description: text(500),
  artworkId: word,
  status: oneOf(LIVE_STATUSES),
  startsAt: instant,
  endsAt: instant,
  entryMinSessions: int(0, 1000),
  leaderboard: bool,
  teams: list({ id: word, name: text(30) }, 10),
  missions: list(
    {
      id: word,
      measure: oneOf(MEASURES),
      target: int(1, 1_000_000),
      dailyMinutes: int(0, 1440),
      name: text(60),
      description: text(280),
    },
    20,
  ),
  milestones: list(
    {
      id: word,
      name: text(60),
      requiredMissions: int(0, 20),
      badgeId: nullableWord,
      trait: bool,
    },
    10,
  ),
  communityTree: tree,
};

const THEME_FIELDS: Record<string, Check> = {
  id: word,
  name: text(60),
  description: text(280),
  environmentId: word,
  hemisphere: oneOf(['north', 'south', null]),
  status: oneOf(LIVE_STATUSES),
  startsAt: instant,
  endsAt: instant,
  rewards: list({ id: word, badgeId: word, requiredActiveDays: int(0, 366) }, 10),
};

export type EventInput = PackEvent & { status: LiveStatus };
export type ThemeInput = PackTheme & { status: LiveStatus };

/** Fields kept editable once people have taken part (events) or the theme has started. */
export const EVENT_OPEN_WHEN_LOCKED = [
  'name',
  'description',
  'artworkId',
  'status',
  'endsAt',
  'leaderboard',
];
export const THEME_OPEN_WHEN_STARTED = ['name', 'description', 'environmentId', 'status', 'endsAt'];

/** Problems of an event or theme body, and its values. An update may hold any subset. */
export function liveBodyProblems(
  kind: 'event' | 'theme',
  mode: 'create' | 'update',
  body: Record<string, unknown>,
): { problems: string[]; values: Record<string, unknown> } {
  const fields = kind === 'event' ? EVENT_FIELDS : THEME_FIELDS;
  const problems: string[] = [];
  const values: Record<string, unknown> = {};
  const reason = body['reason'];
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
    problems.push('reason must say why, in 3 to 500 characters.');
  }
  for (const [name, value] of Object.entries(body)) {
    if (name === 'reason') continue;
    const check = fields[name];
    if (!check) problems.push(`${name} is not a field of a ${kind}.`);
    else if (mode === 'update' && name === 'id')
      problems.push('id cannot be changed once created.');
    else if (check(value, name, problems)) {
      values[name] = typeof value === 'string' ? value.trim() : value;
    }
  }
  if (mode === 'create') {
    for (const name of Object.keys(fields)) {
      if (!(name in body)) problems.push(`${name} is required.`);
    }
  } else if (Object.keys(values).length === 0 && problems.length === 0) {
    problems.push('Change at least one field.');
  }
  return { problems, values };
}

/** What may not change once people took part (events) or the theme started. */
export function lockedProblems(
  kind: 'event' | 'theme',
  current: { endsAt: string },
  values: Record<string, unknown>,
  changed: (name: string) => boolean,
): string[] {
  const open = kind === 'event' ? EVENT_OPEN_WHEN_LOCKED : THEME_OPEN_WHEN_STARTED;
  const why = kind === 'event' ? 'people have taken part' : 'the theme has started';
  const problems = Object.keys(values)
    .filter((name) => !open.includes(name) && changed(name))
    .map((name) => `${name} is locked: ${why}.`);
  const endsAt = values['endsAt'];
  if (typeof endsAt === 'string' && Date.parse(endsAt) < Date.parse(current.endsAt)) {
    problems.push(`endsAt can only move later: ${why}.`);
  }
  return problems;
}
