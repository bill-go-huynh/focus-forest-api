import { Body, Controller, Get, Put } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import { SelectSpeciesDto, type SpeciesResponse } from '../progression/badge.dto.js';
import { RewardsService } from '../progression/rewards.service.js';
import { MonthClosureService } from './month-closure.service.js';
import { MonthlyTreesService, type CurrentTreeResponse } from './monthly-trees.service.js';

// Always the signed-in user's own tree.
@Controller('me')
export class TreesController {
  constructor(
    private readonly trees: MonthlyTreesService,
    private readonly closure: MonthClosureService,
    private readonly rewards: RewardsService,
  ) {}

  /** The current month's tree (Tree Details), created as a Seed on first view. */
  @Get('trees/current')
  async current(@CurrentUser() user: AuthenticatedUser): Promise<CurrentTreeResponse> {
    await this.closure.closeEndedMonths(user.userId);
    return this.trees.current(user.userId);
  }

  /**
   * Chooses the current month's species while its tree is a Seed (A4.3). 409 `species_locked`
   * once the first counted session has grown it.
   */
  @Put('trees/current/species')
  async selectSpecies(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SelectSpeciesDto,
  ): Promise<CurrentTreeResponse> {
    await this.closure.closeEndedMonths(user.userId);
    return this.trees.selectSpecies(user.userId, body.speciesId);
  }

  /** Owned species, and the current month's species and whether it is still open to change. */
  @Get('species')
  async species(@CurrentUser() user: AuthenticatedUser): Promise<SpeciesResponse> {
    await this.closure.closeEndedMonths(user.userId);
    const items = await this.rewards.species(user.userId);
    const tree = await this.trees.currentTree(user.userId);
    return {
      items,
      current: {
        year: tree.year,
        month: tree.month,
        speciesId: tree.species,
        locked: tree.status !== 'growing' || tree.stage !== 'seed',
      },
    };
  }
}
