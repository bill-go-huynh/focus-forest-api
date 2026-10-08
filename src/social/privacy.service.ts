import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { UpdatePrivacyDto } from './dto/social.dto.js';
import { PRIVACY_CATEGORIES, PRIVACY_DEFAULTS, type PrivacySettingsValues } from './visibility.js';

const FIELDS = {
  profile: true,
  forest: true,
  statistics: true,
  badges: true,
  currentTree: true,
} as const;

/** A5.1 `GET|PATCH /me/privacy`. No row means the defaults; the first change writes them all. */
@Injectable()
export class PrivacyService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<PrivacySettingsValues> {
    const row = await this.prisma.privacySettings.findUnique({
      where: { userId },
      select: FIELDS,
    });
    return row ?? { ...PRIVACY_DEFAULTS };
  }

  async update(userId: string, changes: UpdatePrivacyDto): Promise<PrivacySettingsValues> {
    const sent = Object.fromEntries(
      PRIVACY_CATEGORIES.filter((key) => changes[key] !== undefined).map((key) => [
        key,
        changes[key],
      ]),
    ) as Partial<PrivacySettingsValues>;
    if (Object.keys(sent).length === 0) {
      throw new BadRequestException('Send at least one privacy category to change.');
    }
    return this.prisma.privacySettings.upsert({
      where: { userId },
      create: { userId, ...PRIVACY_DEFAULTS, ...sent },
      update: sent,
      select: FIELDS,
    });
  }
}
