import {
  BadRequestException,
  Body,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import {
  AdminController,
  AdminRoles,
  CurrentAdmin,
  type AuthenticatedAdmin,
} from '../admin/admin-route.decorator.js';
import { LeaderboardsService, type StaffBoardDto } from '../leaderboards/leaderboards.service.js';
import { LiveService } from './live.service.js';

type Body = Record<string, unknown>;

/** Live operations (A6.5, docs/09 later admin): seasonal themes and leaderboards. */
@AdminController('live')
@AdminRoles('admin', 'content')
export class LiveController {
  constructor(
    private readonly live: LiveService,
    private readonly leaderboards: LeaderboardsService,
  ) {}

  @Get('themes')
  themes(): Promise<{ items: Body[] }> {
    return this.live.themes();
  }

  @Get('themes/:id')
  theme(@Param('id') id: string): Promise<Body> {
    return this.live.theme(id);
  }

  @Post('themes')
  createTheme(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() body: Body): Promise<Body> {
    return this.live.createTheme(admin.adminId, body);
  }

  @Patch('themes/:id')
  updateTheme(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() body: Body,
  ): Promise<Body> {
    return this.live.updateTheme(admin.adminId, id, body);
  }

  @Delete('themes/:id')
  @HttpCode(204)
  deleteTheme(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() body: Body,
  ): Promise<void> {
    return this.live.deleteTheme(admin.adminId, id, body['reason']);
  }

  /** `?scope=global&period=weekly|monthly` */
  @Get('leaderboards')
  board(@Query() query: Record<string, string | undefined>): Promise<StaffBoardDto> {
    const scope = query['scope'] ?? 'global';
    const period = query['period'] ?? 'weekly';
    if (scope !== 'global' || (period !== 'weekly' && period !== 'monthly')) {
      throw new BadRequestException('scope is global; period is weekly or monthly.');
    }
    return this.leaderboards.staffBoard({ scope, period });
  }

  @Get('leaderboard-exclusions')
  exclusions(): Promise<{ items: Body[] }> {
    return this.live.exclusions();
  }

  @Post('leaderboard-exclusions')
  exclude(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() body: Body): Promise<Body> {
    return this.live.exclude(admin.adminId, body);
  }

  @Delete('leaderboard-exclusions/:userId')
  @HttpCode(204)
  include(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('userId') userId: string,
    @Body() body: Body,
  ): Promise<void> {
    return this.live.include(admin.adminId, userId, body['reason']);
  }
}
