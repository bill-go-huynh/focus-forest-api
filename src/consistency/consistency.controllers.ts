import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Res,
  type PipeTransform,
} from '@nestjs/common';
import type { Response } from 'express';

import { isLocalDate, type LocalDate } from '../common/local-date.js';
import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import {
  DailyGoalDto,
  RecoveryDto,
  WeeklyGoalDto,
  type GoalsResponse,
  type RestDaysResponse,
  type StreakResponse,
} from './consistency.dto.js';
import { GoalsService } from './goals.service.js';
import { RestDaysService } from './rest-days.service.js';
import { StreakService } from './streak.service.js';

class LocalDatePipe implements PipeTransform<string, LocalDate> {
  transform(value: string): LocalDate {
    if (!isLocalDate(value)) {
      throw new BadRequestException('The date must be a calendar date, such as "2026-10-08".');
    }
    return value;
  }
}

// Always the signed-in user's own goals, rest days, and streak.

@Controller('me/goals')
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<GoalsResponse> {
    return this.goals.view(user.userId);
  }

  @Put('daily')
  setDaily(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: DailyGoalDto,
  ): Promise<GoalsResponse> {
    return this.goals.setDaily(user.userId, body.minutes);
  }

  @Put('weekly')
  setWeekly(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: WeeklyGoalDto,
  ): Promise<GoalsResponse> {
    return this.goals.setWeekly(user.userId, { type: body.type, target: body.target });
  }

  /** Ends the weekly goal from next Monday. Idempotent. */
  @Delete('weekly')
  clearWeekly(@CurrentUser() user: AuthenticatedUser): Promise<GoalsResponse> {
    return this.goals.setWeekly(user.userId, null);
  }
}

@Controller('me/rest-days')
export class RestDaysController {
  constructor(private readonly restDays: RestDaysService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<RestDaysResponse> {
    return this.restDays.view(user.userId);
  }

  /** Idempotent: 201 when planned, 200 when it already was. */
  @Put(':date')
  async schedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('date', LocalDatePipe) date: LocalDate,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RestDaysResponse> {
    const { restDays, created } = await this.restDays.schedule(user.userId, date);
    res.status(created ? 201 : 200);
    return restDays;
  }

  @Delete(':date')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('date', LocalDatePipe) date: LocalDate,
  ): Promise<RestDaysResponse> {
    return this.restDays.cancel(user.userId, date);
  }
}

@Controller('me/streak')
export class StreakController {
  constructor(private readonly streak: StreakService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<StreakResponse> {
    return this.streak.view(user.userId);
  }

  /** Accepts the offered recovery. Idempotent: 201 when stored, 200 when it already was. */
  @Post('recoveries')
  async recover(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RecoveryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreakResponse> {
    const { streak, created } = await this.streak.recover(user.userId, body.missedDate);
    res.status(created ? 201 : 200);
    return streak;
  }
}
