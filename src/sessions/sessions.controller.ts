import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import {
  ListSessionsQuery,
  SubmitSessionDto,
  UpdateNoteDto,
  type HistoryPage,
  type SessionResponse,
} from './dto/session.dto.js';
import { SessionsService, type SubmittedSessionResponse } from './sessions.service.js';

// Always the signed-in user's own sessions.
@Controller('me/sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  /** Focus history: newest first, keyset-paginated. */
  @Get()
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListSessionsQuery,
  ): Promise<HistoryPage> {
    return this.sessions.history(user.userId, query.cursor, query.limit);
  }

  /** Idempotent submit with a client-generated id: 201 when stored, 200 for a replay. */
  @Put(':id')
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SubmitSessionDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmittedSessionResponse> {
    const { session, created } = await this.sessions.submit(user.userId, id, body);
    res.status(created ? 201 : 200);
    return session;
  }

  /** The note is private: it is never logged. Answers with the whole session. */
  @Patch(':id/note')
  updateNote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateNoteDto,
  ): Promise<SessionResponse> {
    return this.sessions.updateNote(user.userId, id, body.note);
  }

  /** Highlights the note for the month's Tree Details and recap. Idempotent. */
  @Put(':id/note/highlight')
  highlightNote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SessionResponse> {
    return this.sessions.setNoteHighlight(user.userId, id, true);
  }

  /** Removes the highlight. Idempotent. */
  @Delete(':id/note/highlight')
  unhighlightNote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SessionResponse> {
    return this.sessions.setNoteHighlight(user.userId, id, false);
  }
}
