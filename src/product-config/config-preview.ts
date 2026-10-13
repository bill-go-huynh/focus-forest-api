import { addDays, type LocalDate } from '../common/local-date.js';
import type { DayFocus } from '../focus-stats/focus-stats.js';
import type { GrowthRules } from '../trees/growth-rules.js';
import { computeTreeGrowth, type MonthGrowthInput } from '../trees/tree-growth.js';

/**
 * What a configuration version would change (A6.6; docs/09: "propose a new version, preview its
 * effect on sample months, activate"). Pure: the same sample months grown with the active
 * version's rules and the proposed version's, side by side. Nothing stored is touched: a
 * version applies to growth from its activation on, never to archived trees.
 */

const MIN = 60_000;

export interface ConfigChange {
  key: string;
  active: unknown;
  proposed: unknown;
}

/** The keys whose values differ, in key order; a missing key is null on its side. */
export function configDiff(
  active: Readonly<Record<string, unknown>>,
  proposed: Readonly<Record<string, unknown>>,
): ConfigChange[] {
  const keys = [...new Set([...Object.keys(active), ...Object.keys(proposed)])].sort();
  return keys
    .filter((key) => canonical(active[key]) !== canonical(proposed[key]))
    .map((key) => ({ key, active: active[key] ?? null, proposed: proposed[key] ?? null }));
}

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

export interface SampleMonth {
  id: string;
  label: string;
  input: MonthGrowthInput;
}

const days = (from: LocalDate, count: number, step: number, minutes: number): DayFocus[] =>
  Array.from({ length: count }, (_, i) => ({
    date: addDays(from, i * step),
    focusedMilliseconds: minutes * MIN,
    sessionCount: Math.max(1, Math.ceil(minutes / 50)),
  }));

/** Weekdays of March 2026 (it starts on a Sunday): 22 of them. */
const WEEKDAYS: LocalDate[] = Array.from({ length: 31 }, (_, i) => addDays('2026-03-01', i)).filter(
  (date) => {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return day !== 0 && day !== 6;
  },
);

/** Four typical months, from a few short sessions to long daily focus, and a partial first month. */
export const SAMPLE_MONTHS: readonly SampleMonth[] = [
  {
    id: 'light',
    label: 'Light: 20 minutes on 4 days',
    input: {
      month: { year: 2026, month: 3 },
      joinedOn: '2026-01-01',
      days: days('2026-03-03', 4, 7, 20),
      goalCompletions: { daily: 0, weekly: 0 },
      restDates: [],
    },
  },
  {
    id: 'steady',
    label: 'Steady: 30 minutes every weekday',
    input: {
      month: { year: 2026, month: 3 },
      joinedOn: '2026-01-01',
      days: WEEKDAYS.map((date) => ({ date, focusedMilliseconds: 30 * MIN, sessionCount: 1 })),
      goalCompletions: { daily: 22, weekly: 4 },
      restDates: [],
    },
  },
  {
    id: 'deep',
    label: 'Deep: 3 hours on 20 days',
    input: {
      month: { year: 2026, month: 3 },
      joinedOn: '2026-01-01',
      days: days('2026-03-02', 20, 1, 180),
      goalCompletions: { daily: 20, weekly: 4 },
      restDates: [],
    },
  },
  {
    id: 'first-month',
    label: 'First month: joined on the 20th, 30 minutes a day',
    input: {
      month: { year: 2026, month: 3 },
      joinedOn: '2026-03-20',
      days: days('2026-03-20', 10, 1, 30),
      goalCompletions: { daily: 10, weekly: 1 },
      restDates: [],
    },
  },
];

export interface SampleTree {
  stage: string;
  fullnessLevel: number;
  blossomLevel: number;
  richnessTier: number;
  traitIds: readonly string[];
  activeDays: number;
  focusedMinutes: number;
  growthMinutes: number;
}

export interface SamplePreview {
  id: string;
  label: string;
  active: SampleTree;
  proposed: SampleTree;
}

export function previewSamples(active: GrowthRules, proposed: GrowthRules): SamplePreview[] {
  const grow = (sample: SampleMonth, rules: GrowthRules): SampleTree => {
    const tree = computeTreeGrowth(sample.input, rules);
    return {
      stage: tree.stage,
      fullnessLevel: tree.fullnessLevel,
      blossomLevel: tree.blossomLevel,
      richnessTier: tree.richnessTier,
      traitIds: tree.traitIds,
      activeDays: tree.activeDays,
      focusedMinutes: Math.floor(tree.focusedMilliseconds / MIN),
      growthMinutes: Math.floor(tree.growthMilliseconds / MIN),
    };
  };
  return SAMPLE_MONTHS.map((sample) => ({
    id: sample.id,
    label: sample.label,
    active: grow(sample, active),
    proposed: grow(sample, proposed),
  }));
}
