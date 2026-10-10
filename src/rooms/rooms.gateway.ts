import {
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';

import { AccessTokens } from '../identity/access-tokens.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RoomEvents, RoomsService } from './rooms.service.js';

/** The part of a `ws` socket the channel uses. */
interface Socket {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  on(event: 'message', listener: (data: unknown) => void): void;
}

interface Connection {
  userId: string | null;
  rooms: Set<string>;
}

const OPEN = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A5.4 live room state (docs/07 §6, docs/08 §6): the realtime exception. It carries state only,
 * never presentation. A client sends `{ type: 'auth', token }` (its access token, never in the
 * URL), then `{ type: 'watch', roomId }`; it receives `{ type: 'room', room }` now and after every
 * change, as `GET /rooms/:id` would answer it, and `{ type: 'gone', roomId }` once it may no
 * longer see the room. Changes themselves are REST. One process: events stay in memory, so
 * running several API instances would need a shared channel (Postgres LISTEN/NOTIFY) first.
 */
@WebSocketGateway({ path: '/rooms/live' })
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly connections = new Map<Socket, Connection>();

  constructor(
    private readonly rooms: RoomsService,
    private readonly tokens: AccessTokens,
    private readonly prisma: PrismaService,
    events: RoomEvents,
  ) {
    events.on('changed', (roomId: string) => void this.push(roomId));
  }

  handleConnection(socket: Socket): void {
    this.connections.set(socket, { userId: null, rooms: new Set() });
    socket.on('message', (data) => void this.receive(socket, data));
  }

  handleDisconnect(socket: Socket): void {
    this.connections.delete(socket);
  }

  private async receive(socket: Socket, data: unknown): Promise<void> {
    const connection = this.connections.get(socket);
    if (!connection) return;
    const message = parse(data);
    if (message?.['type'] === 'auth' && typeof message['token'] === 'string') {
      const userId = await this.authenticate(message['token']);
      if (!userId) return send(socket, { type: 'error', code: 'not_authenticated' });
      connection.userId = userId;
      return send(socket, { type: 'authenticated' });
    }
    if (message?.['type'] === 'watch' && typeof message['roomId'] === 'string') {
      if (!connection.userId) return send(socket, { type: 'error', code: 'not_authenticated' });
      const roomId = message['roomId'];
      const room = UUID.test(roomId) ? await this.rooms.viewFor(roomId, connection.userId) : null;
      if (!room) return send(socket, { type: 'error', code: 'room_not_found' });
      connection.rooms.add(roomId);
      return send(socket, { type: 'room', room });
    }
    if (message?.['type'] === 'unwatch' && typeof message['roomId'] === 'string') {
      connection.rooms.delete(message['roomId']);
      return;
    }
    send(socket, { type: 'error', code: 'bad_message' });
  }

  /** The same check as every request: a valid token of an active user. */
  private async authenticate(token: string): Promise<string | null> {
    const verified = await this.tokens.verify(token);
    if (!verified) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: verified.userId },
      select: { status: true },
    });
    return user?.status === 'active' ? verified.userId : null;
  }

  private async push(roomId: string): Promise<void> {
    for (const [socket, connection] of this.connections) {
      if (!connection.userId || !connection.rooms.has(roomId)) continue;
      const room = await this.rooms.viewFor(roomId, connection.userId);
      if (room) {
        send(socket, { type: 'room', room });
      } else {
        connection.rooms.delete(roomId);
        send(socket, { type: 'gone', roomId });
      }
    }
  }
}

function parse(data: unknown): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(String(data));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function send(socket: Socket, message: object): void {
  if (socket.readyState === OPEN) socket.send(JSON.stringify(message));
}
