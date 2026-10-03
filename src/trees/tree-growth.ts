import {
  addDays,
  compareLocalDates,
  firstDateOfMonth,
  lastDateOfMonth,
  weekStartOf,
  type LocalDate,
} from '../common/local-date.js';
import type { DayFocus } from '../focus-stats/focus-stats.js';
import type { MonthRef } from '../sessions/attribution/calendar.js';
import type { EarnedTreeState } from './earned-state.js';
import { firstMonthFactor, prorate, type FirstMonthFactor } from './first-month.js';
import { monthGrowthMilliseconds } from './growth-contribution.js';
import type { GrowthRules } from './growth-rules.js';
import { focusHourTraitId } from './traits.js';
import { TREE_STAGES } from './tree-stages.js';

const HOUR_MS = 60 * 60 * 1000;

/** Everything one month's tree is computed from. No clock, no database. */
export interface MonthGrowthInput {
  month: MonthRef;
  /** The user's join date as a local date in the month's time zone (for a partial first month). */
  joinedOn: LocalDate;
  /** Counted focus per local date, for the sessions attributed to this month. */
  days: readonly DayFocus[];
  /** Goals met in this month (supplied by Goals, A3.2). */
  goalCompletions: { daily: number; weekly: number };
  /** Planned rest days in this month (supplied by rest days, A3.2). */
  restDates: readonly LocalDate[];
}

/**
 * One computation of a monthly tree from its inputs. The permanent dimensions here are what the
 * inputs justify now; merge them with what the tree already earned (mergeEarned), so that a
 * stricter configuration never shrinks a tree.
 */
export interface TreeGrowth extends EarnedTreeState {
  /** Raw counted focus: never capped, prorated, or otherwise changed. */
  focusedMilliseconds: number;
  sessionCount: number;
  activeDays: number;
  /** Focus after the daily soft cap: what drives stage and richness. */
  growthMilliseconds: number;
  /** The stage thresholds after first-month proration (Young Tree … Final Form). */
  stageThresholdsMs: readonly number[];
  firstMonth: FirstMonthFactor;
}

export function computeTreeGrowth(input: MonthGrowthInput, rules: GrowthRules): TreeGrowth {
  const days = input.days.filter((day) => day.sessionCount > 0);
  const focusedMilliseconds = days.reduce((sum, day) => sum + day.focusedMilliseconds, 0);
  const sessionCount = days.reduce((sum, day) => sum + day.sessionCount, 0);
  const growthMilliseconds = monthGrowthMilliseconds(days, rules);

  const factor = firstMonthFactor(input.month, input.joinedOn, rules.firstMonthFloorPercent);
  const stageThresholdsMs = rules.stageThresholdsMs.map((threshold) => prorate(threshold, factor));

  // The first counted session always reaches Sprout; each threshold reached adds a stage.
  const reached = stageThresholdsMs.filter((threshold) => growthMilliseconds >= threshold).length;
  const stage = sessionCount === 0 ? 'seed' : (TREE_STAGES[1 + reached] ?? 'final_form');

  // Richness is growth beyond Final Form; the tree no longer gets bigger.
  const finalForm = stageThresholdsMs[stageThresholdsMs.length - 1] ?? 0;
  const richnessTier =
    stage === 'final_form'
      ? rules.richnessTiersMs.filter(
          (tier) => growthMilliseconds - finalForm >= prorate(tier, factor),
        ).length
      : 0;

  const points =
    input.goalCompletions.daily * rules.blossoms.dailyGoalPoints +
    input.goalCompletions.weekly * rules.blossoms.weeklyGoalPoints;
  const blossomLevel = rules.blossoms.levelThresholds.filter(
    (threshold) => points >= prorate(threshold, factor),
  ).length;

  // Hour milestones count focused hours, not capped growth, and are not prorated.
  const traitIds = [...new Set(rules.focusHourMilestones)]
    .filter((hours) => focusedMilliseconds >= hours * HOUR_MS)
    .map(focusHourTraitId);

  return {
    stage,
    fullnessLevel: fullnessLevel(input, days, factor, rules),
    blossomLevel,
    richnessTier,
    traitIds,
    focusedMilliseconds,
    sessionCount,
    activeDays: days.length,
    growthMilliseconds,
    stageThresholdsMs,
    firstMonth: factor,
  };
}

/**
 * Fullness comes from active days and weekly consistency (docs/03_TREE_SYSTEM.md §4), not hours.
 * Score, in basis points: the active-day share (up to the target) and the share of the month's
 * Monday weeks with enough active days, each weighted. A week only asks for as many active days
 * as it has days in the month after the join date and outside planned rest days, so rest days
 * and the month's partial edge weeks never count against the tree.
 */
function fullnessLevel(
  input: MonthGrowthInput,
  days: readonly DayFocus[],
  factor: FirstMonthFactor,
  rules: GrowthRules,
): number {
  const { fullness } = rules;
  const active = new Set(days.map((day) => day.date));
  const rest = new Set(input.restDates);

  const target = prorate(fullness.targetActiveDays, factor);
  const activeShareBp = Math.floor(
    (fullness.activeDaysWeight * 100 * Math.min(active.size, target)) / target,
  );

  const weeks = new Map<LocalDate, { open: number; active: number }>();
  const monthStart = firstDateOfMonth(input.month);
  const from = compareLocalDates(input.joinedOn, monthStart) > 0 ? input.joinedOn : monthStart;
  const to = lastDateOfMonth(input.month);
  for (let date = from; compareLocalDates(date, to) <= 0; date = addDays(date, 1)) {
    const week = weeks.get(weekStartOf(date)) ?? { open: 0, active: 0 };
    if (!rest.has(date)) week.open += 1;
    if (active.has(date)) week.active += 1;
    weeks.set(weekStartOf(date), week);
  }
  let considered = 0;
  let met = 0;
  for (const week of weeks.values()) {
    const required = Math.min(fullness.activeDaysPerWeek, week.open);
    if (required === 0) continue; // a week of rest days asks nothing
    considered += 1;
    if (week.active >= required) met += 1;
  }
  const weeklyShareBp =
    considered === 0 ? 0 : Math.floor((fullness.weeklyConsistencyWeight * 100 * met) / considered);

  const score = activeShareBp + weeklyShareBp;
  return fullness.levelPercents.filter((percent) => score >= percent * 100).length;
}
