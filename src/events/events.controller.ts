import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import { CelebratedDto, type CommunityTreeDto } from './community-tree.dto.js';
import type { EventDto } from './events.dto.js';
import { EventsService } from './events.service.js';

/** Events are invitations (docs/02): joining is the user's choice. */
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<{ items: EventDto[] }> {
    return this.events.list(user.userId);
  }

  @Get(':id')
  one(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<EventDto> {
    return this.events.one(user.userId, id);
  }

  @Post(':id/join')
  @HttpCode(200)
  join(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<EventDto> {
    return this.events.join(user.userId, id);
  }

  /** A5.7 The event's shared tree. */
  @Get(':id/community-tree')
  communityTree(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<CommunityTreeDto> {
    return this.events.communityTree(user.userId, id);
  }

  /** The celebrations the app has shown (docs/04: once per user). */
  @Post(':id/community-tree/celebrations')
  @HttpCode(204)
  async celebrated(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: CelebratedDto,
  ): Promise<void> {
    await this.events.communityCelebrated(user.userId, id, body.stages);
  }
}
