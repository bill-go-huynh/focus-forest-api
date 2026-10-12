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

/** Live operations (A6.5, docs/09 later admin): events, seasonal themes, and leaderboards. */
@AdminController('live')
@AdminRoles('admin', 'content')
export class LiveController {
  constructor(
    private readonly live: LiveService,
    private readonly leaderboards: LeaderboardsService,
  ) {}

  @Get('events')
  events(): Promise<{ items: Body[] }> {
    return this.live.events();
  }

  @Get('events/:id')
  event(@Param('id') id: string): Promise<Body> {
    return this.live.event(id);
  }

  @Post('events')
  createEvent(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() body: Body): Promise<Body> {
    return this.live.createEvent(admin.adminId, body);
  }

  @Patch('events/:id')
  updateEvent(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() body: Body,
  ): Promise<Body> {
    return this.live.updateEvent(admin.adminId, id, body);
  }

  @Delete('events/:id')
  @HttpCode(204)
  deleteEvent(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id') id: string,
    @Body() body: Body,
  ): Promise<void> {
    return this.live.deleteEvent(admin.adminId, id, body['reason']);
  }

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

  /** `?scope=global|event&period=weekly|monthly&eventId=` */
  @Get('leaderboards')
  board(@Query() query: Record<string, string | undefined>): Promise<StaffBoardDto> {
    const scope = query['scope'];
    const period = query['period'] ?? 'weekly';
    if (
      (scope !== 'global' && scope !== 'event') ||
      (period !== 'weekly' && period !== 'monthly')
    ) {
      throw new BadRequestException('scope is global or event; period is weekly or monthly.');
    }
    return this.leaderboards.staffBoard({ scope, period, eventId: query['eventId'] });
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
