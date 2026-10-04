import { Injectable } from '@nestjs/common';

import { addDays, weekStartOf, type LocalDate } from '../common/local-date.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { consistencyRulesFrom } from './consistency-rules.js';
import type { RestDaysResponse } from './consistency.dto.js';
import { dbDate, localDateFromDb, lockUser } from './db.js';
import { conflict, notFound, unprocessable } from './http-errors.js';
import { checkCancelRestDay, checkNewRestDay, type RestDayRejection } from './rest-days.js';
import { UserTodayService } from './user-today.service.js';

const REJECTIONS: Record<RestDayRejection, string> = {
  rest_day_in_past: 'A rest day can be planned for today or a later day.',
  rest_day_today_not_allowed: 'Today can no longer be made a rest day.',
  rest_day_too_far_ahead: 'Rest days can be planned up to a year ahead.',
  rest_allowance_used: 'This week’s rest days are already planned.',
};

/**
 * Planned rest days. Every write runs under the user's row lock, so concurrent requests see each
 * other and can never exceed the weekly allowance.
 */
@Injectable()
export class RestDaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly userToday: UserTodayService,
  ) {}

  async view(userId: string): Promise<RestDaysResponse> {
    return this.viewIn(this.prisma, userId, await this.userToday.today(userId));
  }

  /** Idempotent: an existing rest day is returned as it is (`created: false`). */
  async schedule(
    userId: string,
    date: LocalDate,
  ): Promise<{ restDays: RestDaysResponse; created: boolean }> {
    const rules = consistencyRulesFrom(await this.config.active()).restDays;
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const today = await this.userToday.today(userId, tx);
      const existing = await tx.restDay.findUnique({
        where: { userId_date: { userId, date: dbDate(date) } },
      });
      if (!existing) {
        const monday = weekStartOf(date);
        const sameWeek = await tx.restDay.findMany({
          where: { userId, date: { gte: dbDate(monday), lte: dbDate(addDays(monday, 6)) } },
        });
        const rejection = checkNewRestDay(
          { date, today, existing: sameWeek.map((row) => localDateFromDb(row.date)) },
          rules,
        );
        if (rejection === 'rest_allowance_used') throw conflict(rejection, REJECTIONS[rejection]);
        if (rejection) throw unprocessable(rejection, REJECTIONS[rejection]);
        await tx.restDay.create({ data: { userId, date: dbDate(date) } });
      }
      return {
        restDays: await this.viewIn(tx, userId, today, rules.maxPerWeek),
        created: !existing,
      };
    });
  }

  /** Cancelling is possible until the day ends, and returns the day to the allowance. */
  async cancel(userId: string, date: LocalDate): Promise<RestDaysResponse> {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const today = await this.userToday.today(userId, tx);
      const rejection = checkCancelRestDay({ date, today });
      if (rejection) throw unprocessable(rejection, 'A rest day that has ended stays a rest day.');
      const { count } = await tx.restDay.deleteMany({ where: { userId, date: dbDate(date) } });
      if (count === 0) throw notFound('rest_day_not_found', 'There is no rest day on this date.');
      return this.viewIn(tx, userId, today);
    });
  }

  /** Every planned rest day of the user (for the streak and vitality). */
  async allDates(
    userId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<LocalDate[]> {
    const rows = await client.restDay.findMany({
      where: { userId },
      orderBy: { date: 'asc' },
    });
    return rows.map((row) => localDateFromDb(row.date));
  }

  private async viewIn(
    client: Prisma.TransactionClient,
    userId: string,
    today: LocalDate,
    perWeek?: number,
  ): Promise<RestDaysResponse> {
    const maxPerWeek =
      perWeek ?? consistencyRulesFrom(await this.config.active()).restDays.maxPerWeek;
    const monday = weekStartOf(today);
    const rows = await client.restDay.findMany({
      where: { userId, date: { gte: dbDate(monday) } },
      orderBy: { date: 'asc' },
    });
    const restDays = rows.map((row) => ({ date: localDateFromDb(row.date) }));
    const sunday = addDays(monday, 6);
    const used = restDays.filter(({ date }) => date <= sunday).length;
    return {
      restDays,
      allowance: {
        perWeek: maxPerWeek,
        weekStart: monday,
        used,
        remaining: Math.max(0, maxPerWeek - used),
      },
    };
  }
}
