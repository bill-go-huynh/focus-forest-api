import { Controller, Get } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import { MonthClosureService } from './month-closure.service.js';
import { MonthlyTreesService, type CurrentTreeResponse } from './monthly-trees.service.js';

// Always the signed-in user's own tree.
@Controller('me')
export class TreesController {
  constructor(
    private readonly trees: MonthlyTreesService,
    private readonly closure: MonthClosureService,
  ) {}

  /** The current month's tree (Tree Details), created as a Seed on first view. */
  @Get('trees/current')
  async current(@CurrentUser() user: AuthenticatedUser): Promise<CurrentTreeResponse> {
    await this.closure.closeEndedMonths(user.userId);
    return this.trees.current(user.userId);
  }
}
