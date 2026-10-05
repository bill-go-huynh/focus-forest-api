import { Injectable } from '@nestjs/common';

import { addDays, type LocalDate } from '../common/local-date.js';
import { FocusStatsService } from '../focus-stats/focus-stats.service.js';
import type { Prisma, StreakRecovery } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { vitalityRulesFrom } from '../trees/growth-rules.js';
import type { VitalityInput } from '../trees/vitality.js';
import { consistencyRulesFrom, type ConsistencyRules } from './consistency-rules.js';
import type { StreakResponse } from './consistency.dto.js';
import { dbDate, localDateFromDb, lockUser } from './db.js';
import { GoalsService } from './goals.service.js';
import { unprocessable } from './http-errors.js';
import { evaluateRecovery, recoveryOffer, type RecoveryIneligibility } from './recovery.js';
import { RestDaysService } from './rest-days.service.js';
import { summarizeStreak, type ActivityHistory } from './streak.js';
import { UserTodayService } from './user-today.service.js';
import { vitalityInputFor } from './vitality-input.js';

const INELIGIBLE: Record<RecoveryIneligibility, string> = {
  not_a_missed_day: 'There is no missed day to keep the streak over on this date.',
  already_recovered: 'This day already keeps the streak.',
  return_window_passed: 'This streak can no longer be kept.',
  no_return_session: 'A focus session on the next day keeps the streak.',
  more_than_one_missed_day: 'Only a single missed day can be bridged.',
  previous_streak_too_short: 'The streak before this day was too short to keep.',
  monthly_limit_reached: 'This month’s streak recovery is already used.',
};

type Client = Prisma.TransactionClient;

/** The streak, its milestones, and the streak recovery the user can accept. */
@Injectable()
export class StreakService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly stats: FocusStatsService,
    private readonly restDays: RestDaysService,
    private readonly goals: GoalsService,
    private readonly userToday: UserTodayService,
  ) {}

  /** Counted focus, planned rest, and recoveries: everything the streak is derived from. */
  async history(userId: string, client: Client = this.prisma): Promise<ActivityHistory> {
    const days = await this.stats.allDays(userId, client);
    const restDates = await this.restDays.allDates(userId, client);
    const recoveries = await client.streakRecovery.findMany({ where: { userId } });
    return {
      activeDates: days.map((day) => day.date),
      restDates,
      recoveredDates: recoveries.map((row) => localDateFromDb(row.missedDate)),
    };
  }

  async view(userId: string): Promise<StreakResponse> {
    const today = await this.userToday.today(userId);
    const rules = consistencyRulesFrom(await this.config.active());
    return this.describe(await this.history(userId), today, rules);
  }

  /**
   * Accepts the recovery of `missedDate` in the caller's transaction, under the user's row lock,
   * so concurrent acceptances store one. Idempotent: a day already recovered is returned as it
   * is (`created: false`). The recovery-acceptance action (`src/streak-recovery/`) runs it with
   * what the recovery causes in progression, in the same transaction (A4.2.G).
   */
  async acceptIn(
    tx: Client,
    userId: string,
    missedDate: LocalDate,
  ): Promise<{ recovery: StreakRecovery; created: boolean }> {
    await lockUser(tx, userId);
    const existing = await tx.streakRecovery.findUnique({
      where: { userId_missedDate: { userId, missedDate: dbDate(missedDate) } },
    });
    if (existing) return { recovery: existing, created: false };

    const rules = consistencyRulesFrom(await this.config.active());
    const today = await this.userToday.today(userId, tx);
    const history = await this.history(userId, tx);
    const evaluation = evaluateRecovery(
      {
        missedDate,
        today,
        history,
        recoveredDatesThisMonth: sameMonth(history.recoveredDates, missedDate),
      },
      rules.recovery,
    );
    if (!evaluation.eligible) {
      throw unprocessable(evaluation.reason, INELIGIBLE[evaluation.reason]);
    }
    const recovery = await tx.streakRecovery.create({
      data: {
        userId,
        missedDate: dbDate(missedDate),
        returnDate: dbDate(evaluation.returnDate),
        mechanic: 'next_day_session',
      },
    });
    return { recovery, created: true };
  }

  /**
   * Vitality's input for `today`: real focus, planned rest, and the daily goals met in the goal
   * window. Recovered days are left out (used by the tree, A3.3).
   */
  async vitalityInput(
    userId: string,
    today: LocalDate,
    client: Client = this.prisma,
  ): Promise<VitalityInput> {
    const { goalWindowDays } = vitalityRulesFrom(await this.config.active());
    const history = await this.history(userId, client);
    const goalMet = await this.goals.metDates(
      userId,
      addDays(today, -(goalWindowDays - 1)),
      today,
      client,
    );
    return vitalityInputFor(today, history, goalMet);
  }

  private describe(
    history: ActivityHistory,
    today: LocalDate,
    rules: ConsistencyRules,
  ): StreakResponse {
    const summary = summarizeStreak(history, today);
    const reached = rules.streakMilestones.filter((days) => days <= summary.current);
    const next = rules.streakMilestones.find((days) => days > summary.current) ?? null;
    return {
      ...summary,
      milestones: { reached, next },
      recovery: {
        offer: recoveryOffer(
          {
            today,
            history,
            recoveredDatesByMonth: (date) => sameMonth(history.recoveredDates, date),
          },
          rules.recovery,
        ),
        usedThisMonth: sameMonth(history.recoveredDates, today).length,
        perMonth: rules.recovery.perMonth,
      },
    };
  }
}

/** The dates in the same calendar month as `date`. */
function sameMonth(dates: readonly LocalDate[], date: LocalDate): LocalDate[] {
  return dates.filter((other) => other.slice(0, 7) === date.slice(0, 7));
}
