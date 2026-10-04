import { Injectable } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import {
  compareLocalDates,
  firstDateOfMonth,
  lastDateOfMonth,
  type LocalDate,
} from '../common/local-date.js';
import { consistencyRulesFrom } from '../consistency/consistency-rules.js';
import { dbDate, localDateFromDb, lockUser } from '../consistency/db.js';
import { GoalsService } from '../consistency/goals.service.js';
import { unprocessable } from '../consistency/http-errors.js';
import { RestDaysService } from '../consistency/rest-days.service.js';
import { streakMilestoneEvents } from '../consistency/streak.js';
import { StreakService } from '../consistency/streak.service.js';
import { UserTodayService } from '../consistency/user-today.service.js';
import { isCounted } from '../focus-stats/focus-stats.js';
import { FocusStatsService } from '../focus-stats/focus-stats.service.js';
import type { FocusSessionStatus, MonthlyTree, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { localDateOf, type MonthRef } from '../sessions/attribution/calendar.js';
import { TimezoneRequiredError } from '../sessions/attribution/month-context.js';
import { MonthAttributionService } from '../sessions/attribution/month-attribution.service.js';
import { mergeEarned, type EarnedChanges, type EarnedTreeState } from './earned-state.js';
import { firstMonthFactor } from './first-month.js';
import { growthRulesFrom, vitalityRulesFrom, type GrowthRules } from './growth-rules.js';
import { parseGrowthResult } from './growth-result.js';
import {
  toTreeProgress,
  type GrowthResultDto,
  type TreeStateDto,
  type TreeTraitDto,
} from './tree.contracts.js';
import { computeTreeGrowth, type TreeGrowth } from './tree-growth.js';
import { variationSeed } from './variation-seed.js';
import { vitalityOn } from './vitality.js';

type Client = Prisma.TransactionClient;

/** The signature species until more species arrive (Phase 4 Progression). */
export const SIGNATURE_SPECIES = 'signature';

export interface CurrentTreeResponse {
  tree: TreeStateDto;
  /** This month so far, from counted sessions. */
  stats: {
    focusedMinutes: number;
    sessionCount: number;
    activeDays: number;
    dailyGoalsMet: number;
    weeklyGoalsMet: number;
    topTopicId: string | null;
  };
}

/**
 * Monthly trees (docs/06_DOMAIN_MODEL.md → MonthlyTree). A tree is created lazily for its month
 * attribution context, as a Seed, with the active configuration version, which it keeps for the
 * whole month. Its earned state changes when a counted session is submitted: the month is
 * recomputed from the stored sessions (the new one included, inside the same transaction) and
 * merged with what was earned, so nothing earned is ever lost. Reading the current tree also
 * reconciles it with stored truth (goals, rest days, recoveries, sessions stored before the tree
 * existed), without a growth result. Vitality is derived on read.
 */
@Injectable()
export class MonthlyTreesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly attribution: MonthAttributionService,
    private readonly stats: FocusStatsService,
    private readonly goals: GoalsService,
    private readonly restDays: RestDaysService,
    private readonly streak: StreakService,
    private readonly userToday: UserTodayService,
    private readonly clock: Clock,
  ) {}

  /** The tree of the month the user is in now, created as a Seed on first view. */
  async current(userId: string): Promise<CurrentTreeResponse> {
    const tree = await this.currentTree(userId);
    const month = { year: tree.year, month: tree.month };
    const [days, topics, goals] = await Promise.all([
      this.stats.monthDays(userId, month),
      this.stats.monthTopics(userId, month),
      this.goals.monthCompletions(userId, month),
    ]);
    return {
      tree: await this.state(this.prisma, userId, tree),
      stats: {
        focusedMinutes: Math.floor(
          days.reduce((sum, day) => sum + day.focusedMilliseconds, 0) / 60_000,
        ),
        sessionCount: days.reduce((sum, day) => sum + day.sessionCount, 0),
        activeDays: days.length,
        dailyGoalsMet: goals.daily,
        weeklyGoalsMet: goals.weekly,
        topTopicId: topics[0]?.topicId ?? null,
      },
    };
  }

  /** The current month's tree state only (for Home). */
  async currentState(userId: string): Promise<TreeStateDto> {
    return this.state(this.prisma, userId, await this.currentTree(userId));
  }

  /**
   * Applies a session just stored in `tx` to its month's tree and returns the growth result to
   * store with it. The caller holds the user's row lock, so trees and traits of one user are
   * written one session at a time.
   */
  async applySession(
    tx: Client,
    userId: string,
    session: { id: string; year: number; month: number; status: FocusSessionStatus },
  ): Promise<GrowthResultDto> {
    const { tree } = await this.ensureTree(tx, userId, session);
    if (!isCounted(session.status)) {
      return parseGrowthResult({
        counted: false,
        monthClosed: false,
        newTraits: [],
        tree: await this.state(tx, userId, tree),
      });
    }

    const { updated, computed, changes } = await this.grow(tx, userId, tree, session.id);
    const state = await this.state(tx, userId, updated, computed);
    const newTraits = changes.newTraitIds
      .map((id) => state.traits.find((trait) => trait.id === id))
      .filter((trait): trait is TreeTraitDto => trait !== undefined);
    return parseGrowthResult({
      counted: true,
      monthClosed: false,
      ...(changes.stage && { stage: changes.stage }),
      ...(changes.fullness && { fullness: changes.fullness }),
      ...(changes.blossoms && { blossoms: changes.blossoms }),
      ...(changes.richness && { richness: changes.richness }),
      newTraits,
      tree: state,
    });
  }

  /**
   * Recomputes the month with the tree's own rules, merges it with what was earned, and stores
   * any rise and new traits. `sessionId` is the session that caused it, if any.
   */
  private async grow(
    tx: Client,
    userId: string,
    tree: MonthlyTree,
    sessionId: string | null,
  ): Promise<{ updated: MonthlyTree; computed: TreeGrowth; changes: EarnedChanges }> {
    const { computed, earned, changes } = await this.evaluate(tx, userId, tree);

    let updated = tree;
    if (raisesLevels(changes)) {
      updated = await tx.monthlyTree.update({
        where: { userId_year_month: { userId, year: tree.year, month: tree.month } },
        data: {
          stage: earned.stage,
          fullnessLevel: earned.fullnessLevel,
          blossomLevel: earned.blossomLevel,
          richnessTier: earned.richnessTier,
        },
      });
    }
    if (changes.newTraitIds.length > 0) {
      const earnedAt = this.clock.now();
      await tx.monthlyTreeTrait.createMany({
        data: changes.newTraitIds.map((traitId) => ({
          userId,
          year: tree.year,
          month: tree.month,
          traitId,
          earnedAt,
          sessionId,
        })),
      });
    }
    return { updated, computed, changes };
  }

  private async currentTree(userId: string): Promise<MonthlyTree> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = await this.attribution.attribute(userId, this.clock.now(), tx);
        const { tree } = await this.ensureTree(tx, userId, now);
        return this.reconcile(tx, userId, tree);
      });
    } catch (error) {
      if (error instanceof TimezoneRequiredError) throw unprocessable(error.code, error.message);
      throw error;
    }
  }

  /**
   * Brings a growing tree up to date with stored truth that changed without a session: a month
   * first viewed after sessions were stored (for example before Phase 3), a daily goal set after
   * the focus that meets it, a rest day, an accepted recovery. Only rises and new traits are
   * stored, under the user's row lock; nothing is written when nothing was earned, and no
   * session or growth result is created or changed. Archived trees are never touched.
   */
  private async reconcile(tx: Client, userId: string, tree: MonthlyTree): Promise<MonthlyTree> {
    if (tree.status !== 'growing') return tree;
    if (!hasChanges((await this.evaluate(tx, userId, tree)).changes)) return tree;

    await lockUser(tx, userId);
    const locked = await tx.monthlyTree.findUniqueOrThrow({
      where: { userId_year_month: { userId, year: tree.year, month: tree.month } },
    });
    if (locked.status !== 'growing') return locked;
    return (await this.grow(tx, userId, locked, null)).updated;
  }

  /** The month recomputed with the tree's own rules, merged with what it has earned. */
  private async evaluate(
    tx: Client,
    userId: string,
    tree: MonthlyTree,
  ): Promise<{ computed: TreeGrowth; earned: EarnedTreeState; changes: EarnedChanges }> {
    const pinned = await this.config.version(tree.configVersion);
    const computed = await this.compute(tx, userId, tree, growthRulesFrom(pinned), [
      ...consistencyRulesFrom(pinned).streakMilestones,
    ]);
    return { computed, ...mergeEarned(await this.earnedOf(tx, tree), computed) };
  }

  /** The month's tree; created as a Seed under the user's row lock when it does not exist. */
  private async ensureTree(
    tx: Client,
    userId: string,
    month: MonthRef,
  ): Promise<{ tree: MonthlyTree; created: boolean }> {
    const where = { userId_year_month: { userId, year: month.year, month: month.month } };
    const existing = await tx.monthlyTree.findUnique({ where });
    if (existing) return { tree: existing, created: false };

    await lockUser(tx, userId);
    const raced = await tx.monthlyTree.findUnique({ where });
    if (raced) return { tree: raced, created: false };

    const context = await tx.monthAttributionContext.findUniqueOrThrow({ where });
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { createdAt: true },
    });
    // The join date as a local date in the month's own time zone (never the profile's now).
    const joinedOn = localDateOf(user.createdAt, context.timezone);
    const config = await this.config.active();
    const factor = firstMonthFactor(
      month,
      joinedOn,
      growthRulesFrom(config).firstMonthFloorPercent,
    );
    const tree = await tx.monthlyTree.create({
      data: {
        userId,
        year: month.year,
        month: month.month,
        species: SIGNATURE_SPECIES,
        variationSeed: BigInt(variationSeed({ userId, ...month })),
        configVersion: config.version,
        joinedOn: dbDate(joinedOn),
        prorationNumerator: factor.numerator,
        prorationDenominator: factor.denominator,
      },
    });
    return { tree, created: true };
  }

  /** The month recomputed from stored truth with the tree's own rules. */
  private async compute(
    tx: Client,
    userId: string,
    tree: MonthlyTree,
    rules: GrowthRules,
    streakMilestones: number[],
  ): Promise<TreeGrowth> {
    const month = { year: tree.year, month: tree.month };
    const first = firstDateOfMonth(month);
    const last = lastDateOfMonth(month);
    const inMonth = (date: LocalDate) =>
      compareLocalDates(date, first) >= 0 && compareLocalDates(date, last) <= 0;

    const days = await this.stats.monthDays(userId, month, tx);
    const goals = await this.goals.monthCompletions(userId, month, tx);
    const restDates = (await this.restDays.allDates(userId, tx)).filter(inMonth);
    const history = await this.streak.history(userId, tx);
    const today = await this.userToday.today(userId, tx);

    const growth = computeTreeGrowth(
      {
        month,
        joinedOn: localDateFromDb(tree.joinedOn),
        days,
        goalCompletions: { daily: goals.daily, weekly: goals.weekly },
        restDates,
      },
      rules,
    );
    const streakTraits = streakMilestoneEvents(history, today, streakMilestones)
      .filter((event) => inMonth(event.date))
      .map((event) => event.traitId);
    return { ...growth, traitIds: [...new Set([...growth.traitIds, ...streakTraits])] };
  }

  private async earnedOf(client: Client, tree: MonthlyTree): Promise<EarnedTreeState> {
    return {
      stage: tree.stage,
      fullnessLevel: tree.fullnessLevel,
      blossomLevel: tree.blossomLevel,
      richnessTier: tree.richnessTier,
      traitIds: (await this.traits(client, tree)).map((trait) => trait.id),
    };
  }

  private async traits(client: Client, tree: MonthlyTree): Promise<TreeTraitDto[]> {
    const rows = await client.monthlyTreeTrait.findMany({
      where: { userId: tree.userId, year: tree.year, month: tree.month },
      orderBy: [{ earnedAt: 'asc' }, { traitId: 'asc' }],
    });
    return rows.map((row) => ({ id: row.traitId, earnedAt: row.earnedAt.toISOString() }));
  }

  /**
   * The tree as the API shows it: its earned state, progress measured with its own rules, and
   * today's vitality (null once archived, A3.4).
   */
  private async state(
    client: Client,
    userId: string,
    tree: MonthlyTree,
    computed?: TreeGrowth,
  ): Promise<TreeStateDto> {
    const rules = growthRulesFrom(await this.config.version(tree.configVersion));
    const growth =
      computed ??
      computeTreeGrowth(
        {
          month: { year: tree.year, month: tree.month },
          joinedOn: localDateFromDb(tree.joinedOn),
          days: await this.stats.monthDays(userId, tree, client),
          goalCompletions: { daily: 0, weekly: 0 },
          restDates: [],
        },
        rules,
      );
    const earned = await this.earnedOf(client, tree);
    let vitality: TreeStateDto['vitality'] = null;
    if (tree.status === 'growing') {
      const today = await this.userToday.today(userId, client);
      vitality = vitalityOn(
        await this.streak.vitalityInput(userId, today, client),
        vitalityRulesFrom(await this.config.active()),
      );
    }
    return {
      year: tree.year,
      month: tree.month,
      status: tree.status,
      species: tree.species,
      variationSeed: Number(tree.variationSeed),
      partialFirstMonth: tree.prorationNumerator < tree.prorationDenominator,
      configVersion: tree.configVersion,
      progress: toTreeProgress(earned, growth, rules),
      traits: await this.traits(client, tree),
      vitality,
    };
  }
}

function raisesLevels(changes: EarnedChanges): boolean {
  return Boolean(changes.stage || changes.fullness || changes.blossoms || changes.richness);
}

function hasChanges(changes: EarnedChanges): boolean {
  return raisesLevels(changes) || changes.newTraitIds.length > 0;
}
