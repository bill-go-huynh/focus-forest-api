import { Body, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';

import {
  AdminController,
  AdminRoles,
  CurrentAdmin,
  type AuthenticatedAdmin,
} from './admin-route.decorator.js';
import {
  AdminUsersService,
  type AdminSessionRow,
  type AdminUserDetail,
  type AdminUserRow,
  type Page,
} from './admin-users.service.js';
import { DeleteUserDto, PageDto, ReasonDto, UserSearchDto } from './dto/admin-users.dto.js';

const uuid = new ParseUUIDPipe({ version: undefined });

/** Users (docs/09 → Users, Support actions, Session diagnostics). */
@AdminController('users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  search(@Query() query: UserSearchDto): Promise<Page<AdminUserRow>> {
    return this.users.search(query.q, query.cursor);
  }

  @Get(':id')
  detail(@Param('id', uuid) id: string): Promise<AdminUserDetail> {
    return this.users.detail(id);
  }

  @Get(':id/sessions')
  sessions(@Param('id', uuid) id: string, @Query() query: PageDto): Promise<Page<AdminSessionRow>> {
    return this.users.sessions(id, query.cursor);
  }

  /** Support cases only: moderators never read notes (A5.3, least privilege). */
  @Post(':id/sessions/:sessionId/note-reveal')
  @AdminRoles('admin', 'support')
  @HttpCode(200)
  revealNote(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', uuid) id: string,
    @Param('sessionId', uuid) sessionId: string,
    @Body() body: ReasonDto,
  ): Promise<{ note: string | null }> {
    return this.users.revealNote(admin.adminId, id, sessionId, body.reason);
  }

  @Post(':id/suspend')
  @AdminRoles('admin')
  @HttpCode(200)
  suspend(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', uuid) id: string,
    @Body() body: ReasonDto,
  ): Promise<AdminUserRow> {
    return this.users.suspend(admin.adminId, id, body.reason);
  }

  @Post(':id/reactivate')
  @AdminRoles('admin')
  @HttpCode(200)
  reactivate(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', uuid) id: string,
    @Body() body: ReasonDto,
  ): Promise<AdminUserRow> {
    return this.users.reactivate(admin.adminId, id, body.reason);
  }

  @Delete(':id')
  @AdminRoles('admin')
  @HttpCode(204)
  async remove(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', uuid) id: string,
    @Body() body: DeleteUserDto,
  ): Promise<void> {
    await this.users.delete(admin.adminId, id, body.reason, body.confirmEmail);
  }
}
