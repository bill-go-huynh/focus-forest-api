import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import { EventEmitter } from 'node:events';

import type { EnvironmentVariables } from '../config/env.validation.js';
import { AccessTokens } from '../identity/access-tokens.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** What a demo action changed for one account, for its phone. */
export type DemoLiveMessage =
  { type: 'session'; session: unknown } | { type: 'refresh'; reason: string };

/** Demo actions announce here; the gateway forwards to the account's open phones. */
@Injectable()
export class DemoEvents extends EventEmitter {
  announce(userId: string, message: DemoLiveMessage): void {
    this.emit('changed', userId, message);
  }
}

interface Socket {
  readyState: number;
  send(data: string): void;
  on(event: 'message', listener: (data: unknown) => void): void;
}

const OPEN = 1;
/** Demo accounts only: a real account's phone never listens here. */
export const DEMO_EMAIL = /^demo\d+(?:-[a-z-]+)?@focusforest\.test$/;

/**
 * DM.1b The demo live channel: so a change an admin makes on the Demo page shows on the phone
 * at once (docs/07 keeps realtime to rooms; this is demo tooling, not product). The phone sends
 * `{ type: 'auth', token }`; a demo account then receives `{ type: 'session', session }` (a
 * session an admin added, as `PUT /me/sessions/:id` answers it, so the app celebrates it) and
 * `{ type: 'refresh' }` (read everything again). Off unless DEMO_TOOLS=on.
 */
@WebSocketGateway({ path: '/demo/live' })
export class DemoLiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly connections = new Map<Socket, string | null>();

  constructor(
    private readonly tokens: AccessTokens,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    events: DemoEvents,
  ) {
    events.on('changed', (userId: string, message: DemoLiveMessage) => {
      for (const [socket, owner] of this.connections) {
        if (owner === userId) send(socket, message);
      }
    });
  }

  handleConnection(socket: Socket): void {
    this.connections.set(socket, null);
    socket.on('message', (data) => void this.receive(socket, data));
  }

  handleDisconnect(socket: Socket): void {
    this.connections.delete(socket);
  }

  private async receive(socket: Socket, data: unknown): Promise<void> {
    if (!this.connections.has(socket)) return;
    const message = parse(data);
    const token = message?.['type'] === 'auth' ? message['token'] : undefined;
    if (typeof token !== 'string') return send(socket, { type: 'error', code: 'bad_message' });
    if (this.config.get('DEMO_TOOLS', { infer: true }) !== 'on') {
      return send(socket, { type: 'error', code: 'demo_off' });
    }
    const verified = await this.tokens.verify(token);
    const user = verified
      ? await this.prisma.user.findUnique({
          where: { id: verified.userId },
          select: { email: true, status: true },
        })
      : null;
    if (!verified || !user || user.status !== 'active') {
      return send(socket, { type: 'error', code: 'not_authenticated' });
    }
    if (!DEMO_EMAIL.test(user.email)) {
      return send(socket, { type: 'error', code: 'not_a_demo_account' });
    }
    this.connections.set(socket, verified.userId);
    send(socket, { type: 'authenticated' });
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
