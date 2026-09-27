import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import {
  CreateTopicDto,
  ListTopicsQuery,
  UpdateTopicDto,
  type TopicResponse,
} from './dto/topic.dto.js';
import { TopicsService } from './topics.service.js';

// Always the signed-in user's own topics. There is no delete (docs/06 → Topic).
@Controller('me/topics')
export class TopicsController {
  constructor(private readonly topics: TopicsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListTopicsQuery,
  ): Promise<TopicResponse[]> {
    return this.topics.list(user.userId, query.status, query.sort);
  }

  /** Idempotent create with a client-generated id: 201 when created, 200 for a replay. */
  @Put(':id')
  async put(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() fields: CreateTopicDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TopicResponse> {
    const { topic, created } = await this.topics.put(user.userId, id, fields);
    res.status(created ? 201 : 200);
    return topic;
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() changes: UpdateTopicDto,
  ): Promise<TopicResponse> {
    return this.topics.update(user.userId, id, changes);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TopicResponse> {
    return this.topics.archive(user.userId, id);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TopicResponse> {
    return this.topics.restore(user.userId, id);
  }
}
