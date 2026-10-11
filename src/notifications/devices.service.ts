import { BadRequestException, Injectable } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type DeviceResponse,
  type FocusLeaseResponse,
  PUSH_TOKEN,
  type RegisterDeviceDto,
} from './notifications.dto.js';

const MAX_LEASE_MS = 24 * 60 * 60_000;

/** Push devices (docs/07: device registration) and the focus lease (docs/02: nothing during focus). */
@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Registers the device to this person, taking it over from whoever had it before. */
  async register(userId: string, token: string, input: RegisterDeviceDto): Promise<DeviceResponse> {
    if (!PUSH_TOKEN.test(token)) {
      throw new BadRequestException({
        code: 'invalid_push_token',
        message: 'Not an Expo push token.',
      });
    }
    const now = this.clock.now();
    const existing = await this.prisma.pushDevice.findUnique({ where: { token } });
    const device = await this.prisma.pushDevice.upsert({
      where: { token },
      create: {
        token,
        userId,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        registeredAt: now,
        lastSeenAt: now,
      },
      update: {
        userId,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        lastSeenAt: now,
        ...(existing?.userId !== userId && { registeredAt: now }),
      },
    });
    return {
      token: device.token,
      platform: device.platform,
      registeredAt: device.registeredAt.toISOString(),
    };
  }

  /** Forgets the device for this person (on sign-out); someone else's device is left alone. */
  async unregister(userId: string, token: string): Promise<void> {
    await this.prisma.pushDevice.deleteMany({ where: { token, userId } });
  }

  async startFocus(userId: string, endsAtText: string): Promise<FocusLeaseResponse> {
    const now = this.clock.now();
    const endsAt = new Date(endsAtText);
    if (
      Number.isNaN(endsAt.getTime()) ||
      endsAt.getTime() <= now.getTime() ||
      endsAt.getTime() > now.getTime() + MAX_LEASE_MS
    ) {
      throw new BadRequestException({
        code: 'invalid_focus_end',
        message: 'endsAt must be within the next 24 hours.',
      });
    }
    await this.prisma.focusLease.upsert({
      where: { userId },
      create: { userId, startedAt: now, endsAt },
      update: { startedAt: now, endsAt },
    });
    return { endsAt: endsAt.toISOString() };
  }

  /** Focus ended: what it held back is due now; nothing else moves. */
  async endFocus(userId: string): Promise<void> {
    const now = this.clock.now();
    await this.prisma.$transaction([
      this.prisma.focusLease.deleteMany({ where: { userId } }),
      this.prisma.notificationOutbox.updateMany({
        where: { userId, status: 'pending', heldForFocus: true },
        data: { notBefore: now, heldForFocus: false },
      }),
    ]);
  }
}
