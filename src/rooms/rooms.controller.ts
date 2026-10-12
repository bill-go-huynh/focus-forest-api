import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';

import {
  AdminController,
  AdminRoles,
  CurrentAdmin,
  type AuthenticatedAdmin,
} from '../admin/admin-route.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import {
  CloseRoomDto,
  CompleteRoomDto,
  CreateRoomDto,
  InviteToRoomDto,
  JoinRoomDto,
  type AdminRoomDto,
  type RoomCompletionDto,
  type RoomDto,
  type RoomInviteDto,
} from './rooms.dto.js';
import { RoomsService } from './rooms.service.js';

const uuid = new ParseUUIDPipe();

/** Focus Together rooms (A5.4). Every change is here; the live channel only pushes state. */
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateRoomDto): Promise<RoomDto> {
    return this.rooms.create(user.userId, body);
  }

  /** Public lobbies with room. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<{ items: RoomDto[] }> {
    return this.rooms.publicLobbies(user.userId);
  }

  @Get('current')
  current(@CurrentUser() user: AuthenticatedUser): Promise<{ room: RoomDto | null }> {
    return this.rooms.current(user.userId);
  }

  @Post('join')
  @HttpCode(200)
  joinByCode(@CurrentUser() user: AuthenticatedUser, @Body() body: JoinRoomDto): Promise<RoomDto> {
    return this.rooms.joinByCode(user.userId, body.code);
  }

  @Get(':id')
  view(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid) id: string): Promise<RoomDto> {
    return this.rooms.viewOrThrow(id, user.userId);
  }

  @Post(':id/join')
  @HttpCode(200)
  join(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid) id: string): Promise<RoomDto> {
    return this.rooms.joinPublic(user.userId, id);
  }

  @Put(':id/ready')
  ready(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid) id: string): Promise<RoomDto> {
    return this.rooms.ready(user.userId, id, true);
  }

  @Delete(':id/ready')
  unready(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid) id: string): Promise<RoomDto> {
    return this.rooms.ready(user.userId, id, false);
  }

  @Post(':id/start')
  @HttpCode(200)
  start(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid) id: string): Promise<RoomDto> {
    return this.rooms.start(user.userId, id);
  }

  @Post(':id/leave')
  @HttpCode(200)
  leave(@CurrentUser() user: AuthenticatedUser, @Param('id', uuid) id: string): Promise<RoomDto> {
    return this.rooms.leave(user.userId, id);
  }

  /** Links the person's own completed session to the room, after they submitted it. */
  @Post(':id/invites')
  @HttpCode(200)
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Body() body: InviteToRoomDto,
  ): Promise<RoomDto> {
    return this.rooms.invite(user.userId, id, body.userIds);
  }

  @Post(':id/complete')
  @HttpCode(200)
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid) id: string,
    @Body() body: CompleteRoomDto,
  ): Promise<RoomCompletionDto> {
    return this.rooms.complete(user.userId, id, body.sessionId);
  }
}

/** Room invitations the viewer received (A6.3). */
@Controller('me/room-invites')
export class RoomInvitesController {
  constructor(private readonly rooms: RoomsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<{ items: RoomInviteDto[] }> {
    return this.rooms.invitations(user.userId);
  }

  @Delete(':roomId')
  @HttpCode(204)
  decline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', uuid) roomId: string,
  ): Promise<void> {
    return this.rooms.declineInvite(user.userId, roomId);
  }
}

/** docs/09 Focus rooms: see active rooms and close one. */
@AdminController('rooms')
@AdminRoles('admin', 'moderator')
export class AdminRoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get()
  list(): Promise<{ items: AdminRoomDto[] }> {
    return this.rooms.adminList();
  }

  @Post(':id/close')
  @HttpCode(200)
  close(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', uuid) id: string,
    @Body() body: CloseRoomDto,
  ): Promise<AdminRoomDto> {
    return this.rooms.adminClose(admin.adminId, id, body.reason);
  }
}
