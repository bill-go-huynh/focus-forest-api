import { Body, Controller, Get, Patch } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from './current-user.decorator.js';
import { UpdatePreferencesDto, type PreferencesResponse } from './dto/preferences.dto.js';
import { PreferencesService } from './preferences.service.js';

// Always the signed-in user's own preferences: there is no user id in the route.
@Controller('me/preferences')
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<PreferencesResponse> {
    return this.preferences.get(user.userId);
  }

  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() changes: UpdatePreferencesDto,
  ): Promise<PreferencesResponse> {
    return this.preferences.update(user.userId, changes);
  }
}
