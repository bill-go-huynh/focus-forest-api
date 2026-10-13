import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import type { ChallengeTemplate } from './challenge-rules.js';
import {
  CreateChallengeDto,
  InviteDto,
  type ChallengeDto,
  type ChallengeListsDto,
} from './challenges.dto.js';
import { ChallengesService } from './challenges.service.js';
import { RateLimit } from '../safety/rate-limit.decorator.js';

const uuid = new ParseUUIDPipe();

/** The configured templates (A5.5). The app words them; the server owns their terms. */
@Controller('challenge-templates')
export class ChallengeTemplatesController {
  constructor(private readonly challenges: ChallengesService) {}

  @Get()
  list(): Promise<{ items: ChallengeTemplate[] }> {
    return this.challenges.templates();
  }
}

@Controller('me/challenges')
export class ChallengesController {
  constructor(private readonly challenges: ChallengesService) {}

  @Get()
  lists(@CurrentUser() user: AuthenticatedUser): Promise<ChallengeListsDto> {
    return this.challenges.lists(user.userId);
  }

  @RateLimit('invites', 'user')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateChallengeDto,
  ): Promise<ChallengeDto> {
    return this.challenges.create(user.userId, body.templateId, body.invite ?? []);
  }

  @Get(':id')
  one(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid) id: string,
  ): Promise<ChallengeDto> {
    return this.challenges.one(user.userId, id);
  }

  @RateLimit('invites', 'user')
  @Post(':id/invite')
  @HttpCode(200)
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Body() body: InviteDto,
  ): Promise<ChallengeDto> {
    return this.challenges.invite(user.userId, id, body.userIds);
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid) id: string,
  ): Promise<ChallengeDto> {
    return this.challenges.accept(user.userId, id);
  }

  /** Declining or leaving leaves no trace and carries no penalty. */
  @Post(':id/decline')
  @HttpCode(204)
  decline(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid) id: string): Promise<void> {
    return this.challenges.decline(user.userId, id);
  }

  @Post(':id/leave')
  @HttpCode(204)
  leave(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid) id: string): Promise<void> {
    return this.challenges.leave(user.userId, id);
  }
}
