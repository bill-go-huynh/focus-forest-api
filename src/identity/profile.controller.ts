import { Body, Controller, Get, Patch } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from './current-user.decorator.js';
import { UpdateProfileDto, type ProfileResponse } from './dto/profile.dto.js';
import { ProfileService } from './profile.service.js';

// Always the signed-in user's own profile: there is no user id in the route.
@Controller('me/profile')
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<ProfileResponse> {
    return this.profiles.get(user.userId);
  }

  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() changes: UpdateProfileDto,
  ): Promise<ProfileResponse> {
    return this.profiles.update(user.userId, changes);
  }
}
