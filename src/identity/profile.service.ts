import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { ProfileResponse, UpdateProfileDto } from './dto/profile.dto.js';

const PROFILE_FIELDS = {
  id: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  timezone: true,
  createdAt: true,
} as const;

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<ProfileResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: PROFILE_FIELDS,
    });
    return toResponse(user);
  }

  async update(userId: string, changes: UpdateProfileDto): Promise<ProfileResponse> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        displayName: changes.displayName,
        bio: changes.bio,
        timezone: changes.timezone,
      },
      select: PROFILE_FIELDS,
    });
    return toResponse(user);
  }
}

function toResponse(user: {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  timezone: string | null;
  createdAt: Date;
}): ProfileResponse {
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    joinDate: user.createdAt.toISOString(),
    timezone: user.timezone,
  };
}
