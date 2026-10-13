import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  type OnModuleInit,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { AdminAuditService } from '../admin/admin-audit.service.js';
import { Clock } from '../common/clock.js';
import { isCounted } from '../focus-stats/focus-stats.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { notificationLinks } from '../notifications/notification-links.js';
import { nameOf } from '../notifications/notification-copy.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AchievementsService } from '../progression/achievements.service.js';
import {
  canComplete,
  isActive,
  ROOM_CODE_ALPHABET,
  ROOM_COUNTDOWN_MS,
  ROOM_LOBBY_TTL_MS,
  roomPhase,
  startPlan,
  type RoomPhase,
} from './room-rules.js';
import type {
  AdminRoomDto,
  CreateRoomDto,
  PlaceState,
  RoomCompletionDto,
  RoomDto,
  RoomInviteDto,
} from './rooms.dto.js';

type Tx = Prisma.TransactionClient;
type Client = Tx | PrismaService;

const WITH_PLACES = {
  participants: {
    include: {
      user: {
        select: {
          id: true,
          email: true,
          username: true,
          displayName: true,
          avatarUrl: true,
          status: true,
        },
      },
    },
    orderBy: [{ joinedAt: 'asc' as const }, { userId: 'asc' as const }],
  },
} satisfies Prisma.FocusRoomInclude;
type LoadedRoom = Prisma.FocusRoomGetPayload<{ include: typeof WITH_PLACES }>;
type Place = LoadedRoom['participants'][number];

/** Room changes, published after their transaction commits. The live channel listens. */
@Injectable()
export class RoomEvents extends EventEmitter {
  changed(roomId: string): void {
    this.emit('changed', roomId);
  }
}

/**
 * A5.4 Focus Together (spec §14, docs/02, docs/06 FocusRoom, docs/07 §6). Every change is REST,
 * in one transaction holding the room row (`FOR UPDATE`); joining and creating also hold the
 * person's room lock, so a person is in at most one active room. The room grows no tree: each
 * participant's focus is their own session, linked here once completed.
 */
@Injectable()
export class RoomsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly achievements: AchievementsService,
    private readonly audit: AdminAuditService,
    private readonly events: RoomEvents,
    private readonly clock: Clock,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    // A room invitation is worth sending while it stands and the room still gathers.
    this.notifications.registerRelevance('focusRoomInvite', async ({ userId, subject, now }) => {
      const invite = await this.prisma.roomInvite.findUnique({
        where: { roomId_inviteeId: { roomId: subject ?? '', inviteeId: userId } },
        include: { room: true },
      });
      return invite !== null && roomPhase(invite.room, now, await this.maxPause()) === 'lobby';
    });
  }

  async create(userId: string, input: CreateRoomDto): Promise<RoomDto> {
    // A six-character code from 32 symbols: a clash is rare, and simply retried.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const roomId = await this.prisma.$transaction(async (tx) => {
          await lockPerson(tx, userId);
          await this.refuseActivePlace(tx, userId);
          const now = this.clock.now();
          const room = await tx.focusRoom.create({
            data: {
              code: newCode(),
              name: input.name,
              topic: input.topic ?? null,
              durationMinutes: input.durationMinutes,
              maxParticipants: input.maxParticipants,
              visibility: input.visibility,
              createdAt: now,
            },
          });
          await tx.roomParticipant.create({ data: { roomId: room.id, userId, joinedAt: now } });
          return room.id;
        });
        this.events.changed(roomId);
        return this.viewOrThrow(roomId, userId);
      } catch (error) {
        if (attempt < 4 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
  }

  async joinByCode(userId: string, code: string): Promise<RoomDto> {
    const room = await this.prisma.focusRoom.findUnique({ where: { code }, select: { id: true } });
    if (!room) throw roomNotFound();
    return this.join(userId, room.id, { byCode: true });
  }

  /**
   * Invites friends into the room while it gathers (A6.3, spec §18 Focus room invite). Only
   * someone in the room invites, and only mutual friends who are active (a block removes the
   * follows both ways, so friends are never blocked); people already in the room are skipped.
   * Each new invitee is notified.
   */
  async invite(userId: string, roomId: string, userIds: readonly string[]): Promise<RoomDto> {
    await this.prisma.$transaction(async (tx) => {
      const room = await lockRoom(tx, roomId);
      const mine = room && room.participants.find((p) => p.userId === userId && !p.leftAt);
      if (!room || !mine) throw roomNotFound();
      const now = this.clock.now();
      const phase = roomPhase(room, now, await this.maxPause());
      if (phase === 'closed' || phase === 'ended') throw roomNotFound();
      if (phase !== 'lobby') throw conflict('room_started', 'This room has already started.');

      const ids = [...new Set(userIds)].filter((id) => id !== userId);
      const friends = ids.length
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT u.id FROM users u
            WHERE u.id = ANY(${ids}::uuid[]) AND u.status = 'active'
              AND EXISTS (SELECT 1 FROM follows WHERE follower_id = ${userId}::uuid AND followee_id = u.id)
              AND EXISTS (SELECT 1 FROM follows WHERE follower_id = u.id AND followee_id = ${userId}::uuid)`
        : [];
      if (friends.length !== ids.length) {
        throw unprocessable('not_a_friend', 'You can invite only your friends.');
      }
      const inRoom = new Set(room.participants.filter((p) => !p.leftAt).map((p) => p.userId));
      const already = new Set(
        (
          await tx.roomInvite.findMany({
            where: { roomId, inviteeId: { in: ids } },
            select: { inviteeId: true },
          })
        ).map((invite) => invite.inviteeId),
      );
      const fresh = ids.filter((id) => !inRoom.has(id) && !already.has(id));
      await tx.roomInvite.createMany({
        data: fresh.map((inviteeId) => ({ roomId, inviteeId, inviterId: userId, createdAt: now })),
      });
      for (const inviteeId of fresh) {
        await this.notifications.enqueue(tx, {
          userId: inviteeId,
          category: 'focusRoomInvite',
          dedupeKey: `room-invite:${roomId}`,
          subject: roomId,
          copy: { category: 'focusRoomInvite', friendName: nameOf(mine.user), roomName: room.name },
          link: notificationLinks.room(roomId),
          requested: false,
          notBefore: now,
          expiresAt: new Date(room.createdAt.getTime() + ROOM_LOBBY_TTL_MS),
        });
      }
    });
    return this.viewOrThrow(roomId, userId);
  }

  /** The rooms the viewer was invited into that still gather, newest invitation first. */
  async invitations(userId: string): Promise<{ items: RoomInviteDto[] }> {
    const invites = await this.prisma.roomInvite.findMany({
      where: { inviteeId: userId },
      include: {
        inviter: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { roomId: 'asc' }],
    });
    const items: RoomInviteDto[] = [];
    for (const invite of invites) {
      const room = await this.viewFor(invite.roomId, userId);
      // Only a gathering room is shown to someone not in it; joining removes the invitation.
      if (!room) continue;
      items.push({ room, from: invite.inviter, invitedAt: invite.createdAt.toISOString() });
    }
    return { items };
  }

  /** Declines an invitation (idempotent). */
  async declineInvite(userId: string, roomId: string): Promise<void> {
    await this.prisma.roomInvite.deleteMany({ where: { roomId, inviteeId: userId } });
  }

  /** Joining by id is for public rooms, and for rooms the person was invited into. */
  joinPublic(userId: string, roomId: string): Promise<RoomDto> {
    return this.join(userId, roomId, { byCode: false });
  }

  async ready(userId: string, roomId: string, ready: boolean): Promise<RoomDto> {
    await this.change(roomId, async (tx, room, now, phase) => {
      const place = presentPlace(room, userId);
      if (!place || place.leftAt) throw roomNotFound();
      if (phase !== 'lobby') throw conflict('room_started', 'This room has already started.');
      await tx.roomParticipant.update({
        where: { roomId_userId: { roomId, userId } },
        data: { readyAt: ready ? (place.readyAt ?? now) : null },
      });
      if (ready) await this.startIfReady(tx, roomId, now, { byHost: false, hostId: null });
    });
    return this.viewOrThrow(roomId, userId);
  }

  async start(userId: string, roomId: string): Promise<RoomDto> {
    await this.change(roomId, async (tx, room, now, phase) => {
      const place = presentPlace(room, userId);
      if (!place || place.leftAt) throw roomNotFound();
      if (phase !== 'lobby') throw conflict('room_started', 'This room has already started.');
      if (hostOf(room)?.userId !== userId) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Only the host can start the room.',
          code: 'not_room_host',
        });
      }
      const started = await this.startIfReady(tx, roomId, now, { byHost: true, hostId: userId });
      if (!started) {
        throw conflict('not_enough_ready', 'At least two people need to be ready to start.');
      }
    });
    return this.viewOrThrow(roomId, userId);
  }

  /**
   * Leaving is always allowed and never announced: the person disappears from the room. In a
   * lobby, the next person becomes host; an empty lobby closes.
   */
  async leave(userId: string, roomId: string): Promise<RoomDto> {
    let after: LoadedRoom | null = null;
    await this.change(roomId, async (tx, room, now, phase) => {
      const place = room.participants.find((p) => p.userId === userId);
      if (!place) throw roomNotFound();
      if (!place.leftAt) {
        await tx.roomParticipant.update({
          where: { roomId_userId: { roomId, userId } },
          data: { leftAt: now, readyAt: null },
        });
        if (phase === 'lobby') {
          const remaining = room.participants.filter((p) => !p.leftAt && p.userId !== userId);
          if (remaining.length === 0) {
            await tx.focusRoom.update({
              where: { id: roomId },
              data: { status: 'closed', closedAt: now },
            });
          } else {
            await this.startIfReady(tx, roomId, now, { byHost: false, hostId: null });
          }
        }
      }
      after = await loadRoom(tx, roomId);
    });
    return this.render(after!, userId, await this.maxPause());
  }

  async complete(userId: string, roomId: string, sessionId: string): Promise<RoomCompletionDto> {
    let badgeIds: string[] = [];
    await this.change(roomId, async (tx, room, now) => {
      const place = room.participants.find((p) => p.userId === userId);
      if (!place) throw roomNotFound();
      if (room.status === 'closed') throw conflict('room_closed', 'This room was closed.');
      const session = await tx.focusSession.findUnique({
        where: { userId_id: { userId, id: sessionId } },
        select: { id: true, startedAt: true, status: true },
      });
      if (!session) {
        throw new NotFoundException({
          statusCode: 404,
          error: 'Not Found',
          message: 'This session does not exist.',
          code: 'session_not_found',
        });
      }
      if (place.sessionId === sessionId) return;
      if (place.sessionId) {
        throw conflict('already_completed', 'You already completed this room.');
      }
      if (!place.inSession || place.leftAt) {
        throw conflict('not_in_session', 'You did not focus in this room.');
      }
      if (!isCounted(session.status)) {
        throw unprocessable('session_not_counted', 'Only a counted session completes a room.');
      }
      if (
        !room.startsAt ||
        !canComplete(room.startsAt, { startedAt: session.startedAt, counted: true })
      ) {
        throw unprocessable('session_not_in_room', 'This session did not start with the room.');
      }
      await tx.roomParticipant.update({
        where: { roomId_userId: { roomId, userId } },
        data: { sessionId, completedAt: now },
      });
      badgeIds = (await this.achievements.evaluateRoomCompletion(tx, userId, roomId))
        .newlyEarnedBadgeIds;
    });
    return {
      room: await this.viewOrThrow(roomId, userId),
      progression: { newlyEarnedBadges: await this.achievements.earnedBadges(userId, badgeIds) },
    };
  }

  /** A room the viewer may see, or 404: their own, or a public lobby without a block between. */
  async viewOrThrow(roomId: string, viewerId: string): Promise<RoomDto> {
    const room = await this.viewFor(roomId, viewerId);
    if (!room) throw roomNotFound();
    return room;
  }

  async viewFor(roomId: string, viewerId: string): Promise<RoomDto | null> {
    const room = await loadRoom(this.prisma, roomId);
    if (!room) return null;
    const maxPause = await this.maxPause();
    const place = presentPlace(room, viewerId);
    if (place) return this.render(room, viewerId, maxPause);
    const phase = roomPhase(room, this.clock.now(), maxPause);
    if (phase !== 'lobby') return null;
    if (room.visibility !== 'public' && !(await this.invited(this.prisma, roomId, viewerId))) {
      return null;
    }
    if (await this.blockedWithAnyone(viewerId, room)) return null;
    return this.render(room, viewerId, maxPause);
  }

  /** The viewer's active room: a place they have not left nor completed, in an active room. */
  async current(userId: string): Promise<{ room: RoomDto | null }> {
    const place = await this.activePlace(this.prisma, userId);
    return { room: place ? await this.viewOrThrow(place, userId) : null };
  }

  /** Public lobbies with room, newest first, without anyone the viewer blocks or is blocked by. */
  async publicLobbies(viewerId: string): Promise<{ items: RoomDto[] }> {
    const now = this.clock.now();
    const rooms = await this.prisma.focusRoom.findMany({
      where: {
        status: 'lobby',
        visibility: 'public',
        createdAt: { gt: new Date(now.getTime() - ROOM_LOBBY_TTL_MS) },
      },
      include: WITH_PLACES,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    const maxPause = await this.maxPause();
    // One read of everyone the viewer blocks or is blocked by, not one per room (A7.5).
    const blocks = await this.prisma.block.findMany({
      where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
      select: { blockerId: true, blockedId: true },
    });
    const blocked = new Set(
      blocks.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId)),
    );
    const items: RoomDto[] = [];
    for (const room of rooms) {
      const present = room.participants.filter((p) => !p.leftAt);
      if (present.length >= room.maxParticipants) continue;
      if (
        room.participants.some(
          (p) => isPresent(p) && p.userId !== viewerId && blocked.has(p.userId),
        )
      ) {
        continue;
      }
      items.push(this.render(room, viewerId, maxPause));
      if (items.length === 50) break;
    }
    return { items };
  }

  async adminList(): Promise<{ items: AdminRoomDto[] }> {
    const now = this.clock.now();
    const maxPause = await this.maxPause();
    const rooms = await this.prisma.focusRoom.findMany({
      where: { status: { in: ['lobby', 'in_session'] } },
      include: WITH_PLACES,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return {
      items: rooms
        .map((room) => ({ room, phase: roomPhase(room, now, maxPause) }))
        .filter(({ phase }) => isActive(phase))
        .map(({ room, phase }) => {
          const host = hostOf(room);
          return {
            id: room.id,
            name: room.name,
            topic: room.topic,
            visibility: room.visibility,
            phase,
            participants: room.participants.filter((p) => isPresent(p)).length,
            host: host
              ? { id: host.user.id, email: host.user.email, username: host.user.username }
              : null,
            createdAt: room.createdAt.toISOString(),
          };
        }),
    };
  }

  /** docs/09 Focus rooms: closing a room, with a reason, audited. Sessions are never touched. */
  async adminClose(adminId: string, roomId: string, reason: string): Promise<AdminRoomDto> {
    await this.change(roomId, async (tx, room, now) => {
      if (room.status === 'closed') throw conflict('room_closed', 'This room is already closed.');
      await tx.focusRoom.update({
        where: { id: roomId },
        data: { status: 'closed', closedAt: now },
      });
      await this.audit.record(
        { adminId, action: 'room.close', targetType: 'room', targetId: roomId, reason },
        tx,
      );
    });
    const room = await loadRoom(this.prisma, roomId);
    const host = hostOf(room!);
    return {
      id: room!.id,
      name: room!.name,
      topic: room!.topic,
      visibility: room!.visibility,
      phase: 'closed',
      participants: room!.participants.filter((p) => isPresent(p)).length,
      host: host
        ? { id: host.user.id, email: host.user.email, username: host.user.username }
        : null,
      createdAt: room!.createdAt.toISOString(),
    };
  }

  private async join(
    userId: string,
    roomId: string,
    options: { byCode: boolean },
  ): Promise<RoomDto> {
    await this.prisma.$transaction(async (tx) => {
      await lockPerson(tx, userId);
      const room = await lockRoom(tx, roomId);
      if (!room) throw roomNotFound();
      const now = this.clock.now();
      const phase = roomPhase(room, now, await this.maxPause());
      if (
        !options.byCode &&
        room.visibility !== 'public' &&
        !(await this.invited(tx, roomId, userId))
      ) {
        throw roomNotFound();
      }
      const mine = room.participants.find((p) => p.userId === userId);
      if (mine && !mine.leftAt) return;
      if (phase === 'closed' || phase === 'ended') throw roomNotFound();
      if (await this.blockedWithAnyone(userId, room, tx)) throw roomNotFound();
      if (phase !== 'lobby') throw conflict('room_started', 'This room has already started.');
      await this.refuseActivePlace(tx, userId);
      const present = room.participants.filter((p) => !p.leftAt);
      if (present.length >= room.maxParticipants) throw conflict('room_full', 'This room is full.');
      await tx.roomParticipant.upsert({
        where: { roomId_userId: { roomId, userId } },
        create: { roomId, userId, joinedAt: now },
        update: { joinedAt: now, leftAt: null, readyAt: null },
      });
      await tx.roomInvite.deleteMany({ where: { roomId, inviteeId: userId } });
    });
    this.events.changed(roomId);
    return this.viewOrThrow(roomId, userId);
  }

  /** One change to a room, under its row lock; listeners hear of it after the commit. */
  private async change(
    roomId: string,
    apply: (tx: Tx, room: LoadedRoom, now: Date, phase: RoomPhase) => Promise<void>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const room = await lockRoom(tx, roomId);
      if (!room) throw roomNotFound();
      const now = this.clock.now();
      await apply(tx, room, now, roomPhase(room, now, await this.maxPause()));
    });
    this.events.changed(roomId);
  }

  /** Starts the lobby when the plan says so: the synchronized start is the server's. */
  private async startIfReady(
    tx: Tx,
    roomId: string,
    now: Date,
    options: { byHost: boolean; hostId: string | null },
  ): Promise<boolean> {
    const room = await loadRoom(tx, roomId);
    const present = room!.participants.filter((p) => !p.leftAt);
    const plan = startPlan(
      present.map((p) => ({
        userId: p.userId,
        ready: p.readyAt !== null || p.userId === options.hostId,
      })),
      { byHost: options.byHost },
    );
    if (!plan.start) return false;
    if (plan.removed.length > 0) {
      await tx.roomParticipant.updateMany({
        where: { roomId, userId: { in: plan.removed } },
        data: { leftAt: now, readyAt: null },
      });
    }
    await tx.roomParticipant.updateMany({
      where: { roomId, leftAt: null },
      data: { inSession: true },
    });
    await tx.focusRoom.update({
      where: { id: roomId },
      data: { status: 'in_session', startsAt: new Date(now.getTime() + ROOM_COUNTDOWN_MS) },
    });
    return true;
  }

  private async invited(client: Client, roomId: string, userId: string): Promise<boolean> {
    return (await client.roomInvite.count({ where: { roomId, inviteeId: userId } })) > 0;
  }

  private async refuseActivePlace(tx: Tx, userId: string): Promise<void> {
    if (await this.activePlace(tx, userId)) {
      throw conflict('already_in_room', 'You are already in a room. Leave it first.');
    }
  }

  private async activePlace(client: Client, userId: string): Promise<string | null> {
    const places = await client.roomParticipant.findMany({
      where: { userId, leftAt: null, completedAt: null, room: { status: { not: 'closed' } } },
      include: { room: true },
    });
    const now = this.clock.now();
    const maxPause = await this.maxPause();
    return places.find((p) => isActive(roomPhase(p.room, now, maxPause)))?.roomId ?? null;
  }

  private async blockedWithAnyone(
    viewerId: string,
    room: LoadedRoom,
    client: Client = this.prisma,
  ): Promise<boolean> {
    const others = room.participants
      .filter((p) => isPresent(p) && p.userId !== viewerId)
      .map((p) => p.userId);
    if (others.length === 0) return false;
    const blocks = await client.block.count({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: { in: others } },
          { blockedId: viewerId, blockerId: { in: others } },
        ],
      },
    });
    return blocks > 0;
  }

  private async maxPause(): Promise<number> {
    return (await this.config.active()).get('session.maxPauseMinutes');
  }

  private render(room: LoadedRoom, viewerId: string, maxPause: number): RoomDto {
    const phase = roomPhase(room, this.clock.now(), maxPause);
    const host = hostOf(room);
    const shown = room.participants.filter((p) => isPresent(p) && p.user.status === 'active');
    const stateOf = (p: Place): PlaceState =>
      p.completedAt ? 'completed' : p.inSession ? 'focusing' : p.readyAt ? 'ready' : 'waiting';
    const mine = room.participants.find((p) => p.userId === viewerId && isPresent(p));
    return {
      id: room.id,
      code: mine && !mine.leftAt ? room.code : null,
      name: room.name,
      topic: room.topic,
      durationMinutes: room.durationMinutes,
      maxParticipants: room.maxParticipants,
      visibility: room.visibility,
      phase,
      startsAt: room.startsAt?.toISOString() ?? null,
      endsAt: room.startsAt
        ? new Date(room.startsAt.getTime() + room.durationMinutes * 60_000).toISOString()
        : null,
      participants: shown.map((p) => ({
        user: {
          id: p.user.id,
          username: p.user.username,
          displayName: p.user.displayName,
          avatarUrl: p.user.avatarUrl,
        },
        host: p.userId === host?.userId,
        state: stateOf(p),
      })),
      you: mine ? { host: mine.userId === host?.userId, state: stateOf(mine) } : null,
    };
  }
}

/** Shown in the room: not left, or left after completing (the completion stays visible). */
function isPresent(place: Place): boolean {
  return !place.leftAt || place.completedAt !== null;
}

function presentPlace(room: LoadedRoom, userId: string): Place | undefined {
  return room.participants.find((p) => p.userId === userId && isPresent(p));
}

/** The host is not stored: the present person who joined first. */
function hostOf(room: LoadedRoom): Place | undefined {
  return room.participants.find((p) => !p.leftAt && p.user.status === 'active');
}

function loadRoom(client: Client, roomId: string): Promise<LoadedRoom | null> {
  return client.focusRoom.findUnique({ where: { id: roomId }, include: WITH_PLACES });
}

async function lockRoom(tx: Tx, roomId: string): Promise<LoadedRoom | null> {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM focus_rooms WHERE id = ${roomId}::uuid FOR UPDATE`;
  return row ? loadRoom(tx, roomId) : null;
}

/** One room action at a time per person, so they are never in two active rooms. */
async function lockPerson(tx: Tx, userId: string): Promise<void> {
  const key = `room-person:${userId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
}

function newCode(): string {
  let code = '';
  for (let i = 0; i < 6; i += 1) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, error: 'Conflict', message, code });
}

function unprocessable(code: string, message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message,
    code,
  });
}

function roomNotFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    message: 'This room does not exist.',
    code: 'room_not_found',
  });
}
