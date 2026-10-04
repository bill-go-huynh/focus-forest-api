import { Controller, Get } from '@nestjs/common';

import { addDays, weekStartOf, type LocalDate } from '../common/local-date.js';
import type {
  GoalsResponse,
  RestDaysResponse,
  StreakResponse,
} from '../consistency/consistency.dto.js';
import { GoalsService } from '../consistency/goals.service.js';
import { RestDaysService } from '../consistency/rest-days.service.js';
import { StreakService } from '../consistency/streak.service.js';
import { UserTodayService } from '../consistency/user-today.service.js';
import type { PendingCeremonyDto } from '../forest/forest.dto.js';
import { FocusStatsService } from '../focus-stats/focus-stats.service.js';
import { ForestService } from '../forest/forest.service.js';
import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import type { TopicResponse } from '../topics/dto/topic.dto.js';
import { TopicsService } from '../topics/topics.service.js';
import { MonthClosureService } from '../trees/month-closure.service.js';
import { MonthlyTreesService } from '../trees/monthly-trees.service.js';
import type { TreeStateDto } from '../trees/tree.contracts.js';

export interface HomeResponse {
  /** The user's local date. */
  today: LocalDate;
  tree: TreeStateDto;
  goals: GoalsResponse;
  streak: StreakResponse;
  rest: { today: boolean; allowance: RestDaysResponse['allowance'] };
  /** Quick-start chips: the first active topics of GET /me/topics?status=active&sort=recent. */
  recentTopics: TopicResponse[];
  /**
   * The latest archived month while its month-end ceremony has not been seen (first open of a
   * new month), else null. Mark it with PUT /me/trees/:year/:month/ceremony-seen.
   */
  pendingCeremony: PendingCeremonyDto | null;
  /** This Monday-to-Sunday week's counted focus so far (by local date), goal or not. */
  week: {
    weekStart: LocalDate;
    focusedMilliseconds: number;
    sessionCount: number;
    activeDays: number;
  };
}

/** Home shows a few quick-start chips; the topic picker has the full list. */
export const HOME_RECENT_TOPICS = 5;

// Always the signed-in user's own Home.
@Controller('me')
export class HomeController {
  constructor(
    private readonly closure: MonthClosureService,
    private readonly trees: MonthlyTreesService,
    private readonly forest: ForestService,
    private readonly goals: GoalsService,
    private readonly streak: StreakService,
    private readonly restDays: RestDaysService,
    private readonly userToday: UserTodayService,
    private readonly topics: TopicsService,
    private readonly stats: FocusStatsService,
  ) {}

  /** Everything Home shows, in one request (docs/07 → Recommendation). */
  @Get('home')
  async home(@CurrentUser() user: AuthenticatedUser): Promise<HomeResponse> {
    // Ended months are planted first, so a new month opens on its own tree.
    await this.closure.closeEndedMonths(user.userId);
    const tree = await this.trees.currentState(user.userId);
    const today = await this.userToday.today(user.userId);
    const weekStart = weekStartOf(today);
    const [goals, streak, rest, topics, pendingCeremony, weekDays] = await Promise.all([
      this.goals.view(user.userId),
      this.streak.view(user.userId),
      this.restDays.view(user.userId),
      this.topics.list(user.userId, 'active', 'recent'),
      this.forest.pendingCeremony(user.userId),
      this.stats.scopeDays(user.userId, { from: weekStart, to: addDays(weekStart, 6) }),
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
      pendingCeremony,
      week: {
        weekStart,
        focusedMilliseconds: weekDays.reduce((sum, day) => sum + day.focusedMilliseconds, 0),
        sessionCount: weekDays.reduce((sum, day) => sum + day.sessionCount, 0),
        activeDays: weekDays.filter((day) => day.sessionCount > 0).length,
      },
    };
  }
}
