import { Injectable } from '@nestjs/common';

import {
  addDays,
  compareLocalDates,
  firstDateOfMonth,
  lastDateOfMonth,
  weekStartOf,
  type LocalDate,
} from '../common/local-date.js';
import { FocusStatsService } from '../focus-stats/focus-stats.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import type { MonthRef } from '../sessions/attribution/calendar.js';
import { consistencyRulesFrom } from './consistency-rules.js';
import type { GoalsResponse } from './consistency.dto.js';
import { dbDate, localDateFromDb, lockUser } from './db.js';
import {
  dailyEffectiveFrom,
  dailyProgress,
  goalMetDates,
  monthGoalCompletions,
  versionOn,
  weeklyEffectiveFrom,
  weeklyGoalForWeek,
  weeklyProgress,
  type DailyGoalVersion,
  type MonthGoalCompletions,
  type WeeklyGoal,
  type WeeklyGoalVersion,
} from './goals.js';
import { UserTodayService } from './user-today.service.js';

type Client = Prisma.TransactionClient;

/**
 * Daily and weekly goals: versioned settings, progress from counted sessions (FocusStats), and
 * the month's completions for the tree's blossoms.
 */
@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly stats: FocusStatsService,
    private readonly userToday: UserTodayService,
  ) {}

  async view(userId: string): Promise<GoalsResponse> {
    const today = await this.userToday.today(userId);
    const defaultMinutes = await this.defaultDailyMinutes();
    const [daily, weekly] = await Promise.all([
      dailyVersions(this.prisma, userId),
      weeklyVersions(this.prisma, userId),
    ]);

    const current = versionOn(daily, today);
    const pendingDaily = daily.find((v) => compareLocalDates(v.effectiveFrom, today) > 0) ?? null;
    const [todayFocus] = await this.stats.daysBetween(userId, today, today);
    const minutes = current?.minutes ?? defaultMinutes;

    const monday = weekStartOf(today);
    const weekGoal = weeklyGoalForWeek(weekly, monday);
    const pendingWeekly =
      weekly.find((v) => compareLocalDates(v.effectiveFrom, monday) > 0) ?? null;
    // `isDefault`: the configured default is shown until the first goal; it is not history.
    const weekDays = weekGoal
      ? await this.stats.daysBetween(userId, monday, addDays(monday, 6))
      : [];

    return {
      daily: {
        minutes,
        isDefault: current === null,
        pending: pendingDaily && {
          minutes: pendingDaily.minutes,
          effectiveFrom: pendingDaily.effectiveFrom,
        },
        today: dailyProgress(today, todayFocus?.focusedMilliseconds ?? 0, minutes),
      },
      weekly: {
        goal: weekGoal,
        pending: pendingWeekly && {
          goal: pendingWeekly.goal,
          effectiveFrom: pendingWeekly.effectiveFrom,
        },
        thisWeek: weekGoal && weeklyProgress(monday, weekDays, weekGoal),
      },
    };
  }

  /**
   * A first daily goal applies today; a change applies tomorrow and replaces any pending change.
   * Setting the value already in effect today just drops a pending change.
   */
  async setDaily(userId: string, minutes: number): Promise<GoalsResponse> {
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const today = await this.userToday.today(userId, tx);
      const versions = await dailyVersions(tx, userId);
      const firstSetting = versions.length === 0;
      const effectiveFrom = dailyEffectiveFrom(today, { firstSetting });
      if (!firstSetting) {
        await tx.dailyGoalSetting.deleteMany({
          where: { userId, effectiveFrom: { gt: dbDate(today) } },
        });
        if (versionOn(versions, today)?.minutes === minutes) return;
      }
      await tx.dailyGoalSetting.create({
        data: { userId, effectiveFrom: dbDate(effectiveFrom), minutes },
      });
    });
    return this.view(userId);
  }

  /**
   * Sets the weekly goal, or clears it (`null`). With no goal in effect this week, a new goal
   * applies to this week; changing or clearing a goal in effect applies from next Monday and
   * replaces any pending change. Asking for what is already in effect drops a pending change.
   * Past versions are never touched.
   */
  async setWeekly(userId: string, goal: WeeklyGoal | null): Promise<GoalsResponse> {
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const today = await this.userToday.today(userId, tx);
      const monday = weekStartOf(today);
      const current = weeklyGoalForWeek(await weeklyVersions(tx, userId), monday);
      await tx.weeklyGoalSetting.deleteMany({
        where: { userId, effectiveFrom: { gt: dbDate(monday) } },
      });
      if (sameGoal(current, goal)) return;

      const effectiveFrom = dbDate(weeklyEffectiveFrom(today, { goalInEffect: current !== null }));
      const values = { type: goal?.type ?? null, target: goal?.target ?? null };
      // With no goal in effect, this week's Monday may hold the version that cleared it.
      await tx.weeklyGoalSetting.upsert({
        where: { userId_effectiveFrom: { userId, effectiveFrom } },
        update: values,
        create: { userId, effectiveFrom, ...values },
      });
    });
    return this.view(userId);
  }

  /**
   * Goals met in a calendar month, each judged by the goal in effect then (the tree's blossom
   * input, used by A3.3). Weeks count in the month of the day their target was reached.
   */
  async monthCompletions(
    userId: string,
    month: MonthRef,
    client: Client = this.prisma,
  ): Promise<MonthGoalCompletions> {
    const from = weekStartOf(firstDateOfMonth(month));
    const to = addDays(weekStartOf(lastDateOfMonth(month)), 6);
    const days = await this.stats.daysBetween(userId, from, to, client);
    const daily = await dailyVersions(client, userId);
    const weekly = await weeklyVersions(client, userId);
    return monthGoalCompletions({ month, days, dailyVersions: daily, weeklyVersions: weekly });
  }

  /** Dates in [from, to] whose daily goal was met (vitality's goal input). */
  async metDates(
    userId: string,
    from: LocalDate,
    to: LocalDate,
    client: Client = this.prisma,
  ): Promise<LocalDate[]> {
    const days = await this.stats.daysBetween(userId, from, to, client);
    const daily = await dailyVersions(client, userId);
    return goalMetDates(days, daily);
  }

  /** Every daily and weekly goal version, oldest first (Insights judges each day by these). */
  async versions(
    userId: string,
    client: Client = this.prisma,
  ): Promise<{ daily: DailyGoalVersion[]; weekly: WeeklyGoalVersion[] }> {
    return {
      daily: await dailyVersions(client, userId),
      weekly: await weeklyVersions(client, userId),
    };
  }

  private async defaultDailyMinutes(): Promise<number> {
    return consistencyRulesFrom(await this.config.active()).dailyGoalDefaultMinutes;
  }
}

async function dailyVersions(client: Client, userId: string): Promise<DailyGoalVersion[]> {
  const rows = await client.dailyGoalSetting.findMany({
    where: { userId },
    orderBy: { effectiveFrom: 'asc' },
  });
  return rows.map((row) => ({
    effectiveFrom: localDateFromDb(row.effectiveFrom),
    minutes: row.minutes,
  }));
}

async function weeklyVersions(client: Client, userId: string): Promise<WeeklyGoalVersion[]> {
  const rows = await client.weeklyGoalSetting.findMany({
    where: { userId },
    orderBy: { effectiveFrom: 'asc' },
  });
  return rows.map((row) => ({
    effectiveFrom: localDateFromDb(row.effectiveFrom),
    goal: row.type !== null && row.target !== null ? { type: row.type, target: row.target } : null,
  }));
}

function sameGoal(a: WeeklyGoal | null, b: WeeklyGoal | null): boolean {
  return a === null || b === null ? a === b : a.type === b.type && a.target === b.target;
}
