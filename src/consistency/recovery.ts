import { addDays, compareLocalDates, daysBetween, type LocalDate } from '../common/local-date.js';
import { streakEndingOn, type ActivityHistory } from './streak.js';

/**
 * Streak recovery (docs/06_DOMAIN_MODEL.md → StreakRecovery), one mechanic: a counted session on
 * the day right after exactly one missed day keeps a streak of at least `minPreviousStreak`.
 * The user accepts the offer; it stays open until the end of the day after the return day.
 * A recovered day bridges the streak only: it is not an active day, meets no goal, and adds no
 * growth or vitality.
 */

export interface RecoveryRules {
  minPreviousStreak: number;
  /** Recoveries per calendar month of the missed day. */
  perMonth: number;
}

export type RecoveryIneligibility =
  | 'not_a_missed_day'
  | 'already_recovered'
  | 'return_window_passed'
  | 'no_return_session'
  | 'more_than_one_missed_day'
  | 'previous_streak_too_short'
  | 'monthly_limit_reached';

export type RecoveryEvaluation =
  | { eligible: true; missedDate: LocalDate; returnDate: LocalDate; previousStreak: number }
  | { eligible: false; reason: RecoveryIneligibility };

export interface RecoveryInput {
  missedDate: LocalDate;
  today: LocalDate;
  history: ActivityHistory;
  /** Missed dates already recovered in the missed date's calendar month. */
  recoveredDatesThisMonth: readonly LocalDate[];
}

export function evaluateRecovery(input: RecoveryInput, rules: RecoveryRules): RecoveryEvaluation {
  const { missedDate, today, history } = input;
  const no = (reason: RecoveryIneligibility): RecoveryEvaluation => ({ eligible: false, reason });

  if (history.recoveredDates.includes(missedDate)) return no('already_recovered');
  if (
    compareLocalDates(missedDate, today) >= 0 ||
    history.activeDates.includes(missedDate) ||
    history.restDates.includes(missedDate)
  ) {
    return no('not_a_missed_day');
  }

  const returnDate = addDays(missedDate, 1);
  if (daysBetween(returnDate, today) > 1) return no('return_window_passed');
  if (!history.activeDates.includes(returnDate) || history.restDates.includes(returnDate)) {
    return no('no_return_session');
  }

  if (missedBefore(history, missedDate)) return no('more_than_one_missed_day');
  const previousStreak = streakEndingOn(history, addDays(missedDate, -1));
  if (previousStreak < rules.minPreviousStreak) return no('previous_streak_too_short');

  const usedThisMonth = input.recoveredDatesThisMonth.filter((date) => date !== missedDate).length;
  if (usedThisMonth >= rules.perMonth) return no('monthly_limit_reached');

  return { eligible: true, missedDate, returnDate, previousStreak };
}

export interface RecoveryOffer {
  missedDate: LocalDate;
  returnDate: LocalDate;
  previousStreak: number;
}

/** The recovery the user can accept today, if any: yesterday or the day before was missed. */
export function recoveryOffer(
  input: {
    today: LocalDate;
    history: ActivityHistory;
    /** Missed dates already recovered in the calendar month of a date. */
    recoveredDatesByMonth: (date: LocalDate) => readonly LocalDate[];
  },
  rules: RecoveryRules,
): RecoveryOffer | null {
  for (const back of [1, 2]) {
    const missedDate = addDays(input.today, -back);
    const evaluation = evaluateRecovery(
      {
        missedDate,
        today: input.today,
        history: input.history,
        recoveredDatesThisMonth: input.recoveredDatesByMonth(missedDate),
      },
      rules,
    );
    if (evaluation.eligible) {
      return {
        missedDate: evaluation.missedDate,
        returnDate: evaluation.returnDate,
        previousStreak: evaluation.previousStreak,
      };
    }
  }
  return null;
}

/**
 * Whether the day before `missedDate` (looking past rest and recovered days) was missed too,
 * after earlier focus: a gap of two or more days. With no focus before, there is simply no
 * previous streak.
 */
function missedBefore(history: ActivityHistory, missedDate: LocalDate): boolean {
  const bridges = new Set([...history.restDates, ...history.recoveredDates]);
  let date = addDays(missedDate, -1);
  while (bridges.has(date) && !history.activeDates.includes(date)) date = addDays(date, -1);
  if (history.activeDates.includes(date)) return false;
  return history.activeDates.some((active) => compareLocalDates(active, date) < 0);
}
