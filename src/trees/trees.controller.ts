import { Controller, Get } from '@nestjs/common';

import type { LocalDate } from '../common/local-date.js';
import type {
  GoalsResponse,
  RestDaysResponse,
  StreakResponse,
} from '../consistency/consistency.dto.js';
import { GoalsService } from '../consistency/goals.service.js';
import { RestDaysService } from '../consistency/rest-days.service.js';
import { StreakService } from '../consistency/streak.service.js';
import { UserTodayService } from '../consistency/user-today.service.js';
import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import type { TopicResponse } from '../topics/dto/topic.dto.js';
import { TopicsService } from '../topics/topics.service.js';
import { MonthlyTreesService, type CurrentTreeResponse } from './monthly-trees.service.js';
import type { TreeStateDto } from './tree.contracts.js';

export interface HomeResponse {
  /** The user's local date. */
  today: LocalDate;
  tree: TreeStateDto;
  goals: GoalsResponse;
  streak: StreakResponse;
  rest: { today: boolean; allowance: RestDaysResponse['allowance'] };
  /** Quick-start chips: the first active topics of GET /me/topics?status=active&sort=recent. */
  recentTopics: TopicResponse[];
}

/** Home shows a few quick-start chips; the topic picker has the full list. */
export const HOME_RECENT_TOPICS = 5;

// Always the signed-in user's own tree.
@Controller('me')
export class TreesController {
  constructor(
    private readonly trees: MonthlyTreesService,
    private readonly goals: GoalsService,
    private readonly streak: StreakService,
    private readonly restDays: RestDaysService,
    private readonly userToday: UserTodayService,
    private readonly topics: TopicsService,
  ) {}

  /** The current month's tree (Tree Details), created as a Seed on first view. */
  @Get('trees/current')
  current(@CurrentUser() user: AuthenticatedUser): Promise<CurrentTreeResponse> {
    return this.trees.current(user.userId);
  }

  /** Everything Home shows, in one request (docs/07 → Recommendation). */
  @Get('home')
  async home(@CurrentUser() user: AuthenticatedUser): Promise<HomeResponse> {
    const tree = await this.trees.currentState(user.userId);
    const today = await this.userToday.today(user.userId);
    const [goals, streak, rest, topics] = await Promise.all([
      this.goals.view(user.userId),
      this.streak.view(user.userId),
      this.restDays.view(user.userId),
      this.topics.list(user.userId, 'active', 'recent'),
    ]);
    return {
      today,
      tree,
      goals,
      streak,
      rest: {
        today: rest.restDays.some((day) => day.date === today),
        allowance: rest.allowance,
      },
      recentTopics: topics.slice(0, HOME_RECENT_TOPICS),
    };
  }
}
