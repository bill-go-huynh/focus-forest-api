import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ProfileResponse, UpdateProfileDto } from './dto/profile.dto.js';
import { parseUsername } from './username.js';

const PROFILE_FIELDS = {
  id: true,
  displayName: true,
  username: true,
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
    const username = changes.username === undefined ? undefined : checkedUsername(changes.username);
    try {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data: {
          displayName: changes.displayName,
          bio: changes.bio,
          timezone: changes.timezone,
          username,
        },
        select: PROFILE_FIELDS,
      });
      return toResponse(user);
    } catch (error) {
      // The only unique field a profile change can write is the username.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: 'That username is taken.',
          code: 'username_taken',
        });
      }
      throw error;
    }
  }
}

function checkedUsername(input: string): string {
  const parsed = parseUsername(input);
  if (parsed.ok) return parsed.username;
  if (parsed.reason === 'reserved') {
    throw new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'That username is reserved.',
      code: 'username_reserved',
    });
  }
  throw new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: 'A username has 3–20 letters, digits, or underscores.',
    code: 'username_invalid',
  });
}

function toResponse(user: {
  id: string;
  displayName: string | null;
  username: string | null;
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
    username: user.username,
  };
}
