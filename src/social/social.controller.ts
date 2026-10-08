import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  Query,
} from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import {
  CursorQuery,
  SearchUsersQuery,
  UpdatePrivacyDto,
  type BlockedUserResponse,
  type PageResponse,
  type UserCardResponse,
  type UserSummaryResponse,
} from './dto/social.dto.js';
import { PrivacyService } from './privacy.service.js';
import { SocialGraphService } from './social-graph.service.js';
import type { PrivacySettingsValues } from './visibility.js';

const userId = new ParseUUIDPipe();

/** Other users, always seen through the privacy policy (A5.1). */
@Controller('users')
export class UsersController {
  constructor(private readonly graph: SocialGraphService) {}

  @Get('search')
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SearchUsersQuery,
  ): Promise<PageResponse<UserSummaryResponse>> {
    return this.graph.search(user.userId, query.q);
  }

  @Get(':userId')
  card(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', userId) targetId: string,
  ): Promise<UserCardResponse> {
    return this.graph.card(user.userId, targetId);
  }
}

@Controller('me')
export class SocialGraphController {
  constructor(private readonly graph: SocialGraphService) {}

  @Get('following')
  following(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CursorQuery,
  ): Promise<PageResponse<UserSummaryResponse>> {
    return this.graph.following(user.userId, query.cursor);
  }

  @Put('following/:userId')
  @HttpCode(200)
  follow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', userId) targetId: string,
  ): Promise<UserSummaryResponse> {
    return this.graph.follow(user.userId, targetId);
  }

  @Delete('following/:userId')
  @HttpCode(204)
  unfollow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', userId) targetId: string,
  ): Promise<void> {
    return this.graph.unfollow(user.userId, targetId);
  }

  @Get('followers')
  followers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CursorQuery,
  ): Promise<PageResponse<UserSummaryResponse>> {
    return this.graph.followers(user.userId, query.cursor);
  }

  @Delete('followers/:userId')
  @HttpCode(204)
  removeFollower(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', userId) followerId: string,
  ): Promise<void> {
    return this.graph.removeFollower(user.userId, followerId);
  }

  @Get('blocks')
  blocks(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CursorQuery,
  ): Promise<PageResponse<BlockedUserResponse>> {
    return this.graph.blocks(user.userId, query.cursor);
  }

  @Put('blocks/:userId')
  @HttpCode(204)
  block(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', userId) targetId: string,
  ): Promise<void> {
    return this.graph.block(user.userId, targetId);
  }

  @Delete('blocks/:userId')
  @HttpCode(204)
  unblock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', userId) targetId: string,
  ): Promise<void> {
    return this.graph.unblock(user.userId, targetId);
  }
}

@Controller('me/privacy')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<PrivacySettingsValues> {
    return this.privacy.get(user.userId);
  }

  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() changes: UpdatePrivacyDto,
  ): Promise<PrivacySettingsValues> {
    return this.privacy.update(user.userId, changes);
  }
}
