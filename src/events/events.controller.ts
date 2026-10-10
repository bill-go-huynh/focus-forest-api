import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
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
}
