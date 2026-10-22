import { isContentId } from '../progression/progression-rules.js';
import { PERSONAL_RECORD_KINDS, type PersonalRecord } from '../records/personal-records.js';
import type { ProductiveDay, ProductiveWeek } from '../records/month-highlights.js';
import { isLevel, isLocalDate, isObject, isProgress, isString, isTrait } from './json-checks.js';
import type { TreeProgressDto, TreeStateDto, TreeTraitDto } from './tree.contracts.js';

/**
 * The immutable snapshots of a closed month (docs/06_DOMAIN_MODEL.md → MonthlyTree, MonthlyRecap):
 * what the archived tree and its recap show, taken once in the archive transaction and read back
 * as stored. Nothing here is recomputed from sessions or configuration.
 */

export interface TopicSummaryDto {
  id: string;
  name: string;
  icon: string;
  color: string;
}

/** The month's stats as they were at archive (Tree Details, spec §5.2). */
export interface ArchivedMonthStatsDto {
  focusedMinutes: number;
  sessionCount: number;
  activeDays: number;
  dailyGoalsMet: number;
  weeklyGoalsMet: number;
  /** The longest streak reached on any day of the month, in active days. */
  longestStreak: number;
  /** The topic with the most counted focus, as it was named then. */
  topTopic: TopicSummaryDto | null;
}

/** Stored in monthly_trees.archive. No vitality: an archived tree renders at rest. */
export interface TreeArchive {
  /** The month's attribution time zone. */
  timezone: string;
  progress: TreeProgressDto;
  traits: TreeTraitDto[];
  stats: ArchivedMonthStatsDto;
}

/** Stored in monthly_recaps.content: the recap and the archived Tree Details read it. */
export interface RecapContent {
  stats: ArchivedMonthStatsDto;
  mostProductiveDay: ProductiveDay | null;
  mostProductiveWeek: ProductiveWeek | null;
  /** Personal records this month set (A3.5 Insights shows the same records). */
  newRecords: PersonalRecord[];
  /**
   * The notes highlighted at archive, as they read then, in session start order. Later edits,
   * deletions, or highlight changes never reach this snapshot.
   */
  highlightedNotes: HighlightedNoteDto[];
  /**
   * The badges earned this month (A4.2): owned badges whose earned time falls in the month's
   * attribution window, copied at archive by stable id. Never regenerated, so a badge earned or
   * granted later never appears here. Empty in recaps archived before A4.2.
   */
  badges: RecapBadge[];
}

export interface RecapBadge {
  badgeId: string;
  earnedAt: string;
}

/** A note highlighted for its month, copied at archive. Personal data: the owner only. */
export interface HighlightedNoteDto {
  sessionId: string;
  note: string;
}

/** The archived tree as the API shows it, from its row and snapshot alone. */
export function archivedTreeState(
  row: {
    year: number;
    month: number;
    species: string;
    variationSeed: bigint;
    configVersion: number;
    prorationNumerator: number;
    prorationDenominator: number;
  },
  archive: TreeArchive,
): TreeStateDto {
  return {
    year: row.year,
    month: row.month,
    status: 'archived',
    species: row.species,
    variationSeed: Number(row.variationSeed),
    partialFirstMonth: row.prorationNumerator < row.prorationDenominator,
    configVersion: row.configVersion,
    progress: archive.progress,
    traits: archive.traits,
    vitality: null,
  };
}

export function parseTreeArchive(value: unknown): TreeArchive {
  const fail = (why: string): never => {
    throw new Error(`Invalid tree archive: ${why}.`);
  };
  if (!isObject(value)) return fail('not an object');
  if (!hasOnly(value, ['timezone', 'progress', 'traits', 'stats'])) fail('unexpected fields');
  if (!isString(value['timezone'])) fail('bad timezone');
  if (!isProgress(value['progress'])) fail('bad progress');
  const traits = value['traits'];
  if (!Array.isArray(traits) || !traits.every(isTrait)) fail('bad traits');
  if (!isStats(value['stats'])) fail('bad stats');
  return value as unknown as TreeArchive;
}

export function parseRecapContent(value: unknown): RecapContent {
  const fail = (why: string): never => {
    throw new Error(`Invalid recap: ${why}.`);
  };
  const keys = [
    'stats',
    'mostProductiveDay',
    'mostProductiveWeek',
    'newRecords',
    'highlightedNotes',
    'badges',
  ];
  if (!isObject(value)) return fail('not an object');
  if (!hasOnly(value, keys)) fail('unexpected fields');
  if (!isStats(value['stats'])) fail('bad stats');
  if (!isNullOr(value['mostProductiveDay'], (day) => isHighlight(day, 'date'))) fail('bad day');
  if (!isNullOr(value['mostProductiveWeek'], (week) => isHighlight(week, 'weekStart'))) {
    fail('bad week');
  }
  const records = value['newRecords'];
  if (!Array.isArray(records) || !records.every(isRecord)) fail('bad newRecords');
  const notes = value['highlightedNotes'];
  if (!Array.isArray(notes) || !notes.every(isHighlightedNote)) fail('bad highlightedNotes');
  const badges = value['badges'];
  if (!Array.isArray(badges) || !badges.every(isRecapBadge)) fail('bad badges');
  return value as unknown as RecapContent;
}

function hasOnly(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function isHighlightedNote(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnly(value, ['sessionId', 'note']) &&
    isString(value['sessionId']) &&
    isString(value['note']) &&
    value['note'] !== ''
  );
}

function isRecapBadge(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnly(value, ['badgeId', 'earnedAt']) &&
    isString(value['badgeId']) &&
    isContentId(value['badgeId']) &&
    isString(value['earnedAt']) &&
    !Number.isNaN(Date.parse(value['earnedAt']))
  );
}

function isNullOr(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === null || check(value);
}

function isHighlight(value: unknown, dateKey: string): boolean {
  return isObject(value) && isLocalDate(value[dateKey]) && isLevel(value['focusedMinutes']);
}

function isRecord(value: unknown): boolean {
  return (
    isObject(value) &&
    PERSONAL_RECORD_KINDS.some((kind) => kind === value['kind']) &&
    isLevel(value['value']) &&
    (value['unit'] === 'minutes' || value['unit'] === 'days') &&
    isLocalDate(value['achievedOn'])
  );
}

function isTopic(value: unknown): boolean {
  return isObject(value) && ['id', 'name', 'icon', 'color'].every((key) => isString(value[key]));
}

function isStats(value: unknown): boolean {
  return (
    isObject(value) &&
    [
      'focusedMinutes',
      'sessionCount',
      'activeDays',
      'dailyGoalsMet',
      'weeklyGoalsMet',
      'longestStreak',
    ].every((key) => isLevel(value[key])) &&
    isNullOr(value['topTopic'], isTopic)
  );
}
