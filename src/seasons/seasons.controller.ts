import { Body, Controller, Get, Put } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import { HemisphereDto, type SeasonDto } from './seasons.dto.js';
import { SeasonsService } from './seasons.service.js';

/** A5.9 The user's season (spec §17). */
@Controller('me/season')
export class SeasonsController {
  constructor(private readonly seasons: SeasonsService) {}

  @Get()
  season(@CurrentUser() user: AuthenticatedUser): Promise<SeasonDto> {
    return this.seasons.season(user.userId);
  }

  @Put('hemisphere')
  hemisphere(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: HemisphereDto,
  ): Promise<SeasonDto> {
    return this.seasons.setHemisphere(user.userId, body.hemisphere);
  }
}
