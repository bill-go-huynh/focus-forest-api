import { BadRequestException, Injectable } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { lockUser } from '../consistency/db.js';
import { unprocessable } from '../consistency/http-errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AchievementsService } from './achievements.service.js';
import {
  toCosmeticDto,
  toSpeciesDto,
  type CosmeticDto,
  type CosmeticsResponse,
  type EquipmentResponse,
  type SpeciesDto,
} from './badge.dto.js';
import { ProgressionOwnershipService } from './progression-ownership.service.js';
import { acquirableAt } from './progression-rules.js';
import { FOREST_SLOTS, checkEquip, isEquipmentSlot, type EquipmentSlot } from './rewards-rules.js';

const EQUIP_MESSAGES = {
  cosmetic_not_owned: 'Only cosmetics you own can be used.',
  cosmetic_wrong_slot: 'This cosmetic does not go in that place.',
} as const;

/**
 * Owned species and cosmetics, and equipment (A4.3). Reads reconcile first, so rewards linked to
 * badges owned before A4.3 are granted lazily. Equipment is presentation state: one owned
 * cosmetic per slot, apart from ownership, never on trees, archives, recaps, or the forest's
 * progression.
 */
@Injectable()
export class RewardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: ProgressionOwnershipService,
    private readonly achievements: AchievementsService,
    private readonly clock: Clock,
  ) {}

  /** Owned species in catalog order, each selectable when it can be chosen for a month now. */
  async species(userId: string): Promise<(SpeciesDto & { selectable: boolean })[]> {
    await this.achievements.reconcile(userId);
    const now = this.clock.now();
    return (await this.ownership.ownedSpecies(userId)).map(({ species }) => ({
      ...toSpeciesDto(species),
      selectable: species.status === 'active' && acquirableAt(species, now).acquirable,
    }));
  }

  async cosmetics(userId: string): Promise<CosmeticsResponse> {
    await this.achievements.reconcile(userId);
    const [owned, equipped] = await Promise.all([
      this.ownership.ownedCosmetics(userId),
      this.prisma.userEquipment.findMany({ where: { userId }, select: { cosmeticId: true } }),
    ]);
    const equippedIds = new Set(equipped.map((row) => row.cosmeticId));
    return {
      items: owned.map(({ cosmetic }) => ({
        ...toCosmeticDto(cosmetic),
        equipped: equippedIds.has(cosmetic.id),
      })),
    };
  }

  async equipment(userId: string): Promise<EquipmentResponse> {
    const rows = await this.prisma.userEquipment.findMany({
      where: { userId },
      include: { cosmetic: true },
    });
    const bySlot = new Map<EquipmentSlot, CosmeticDto>(
      rows.map((row) => [row.slot, toCosmeticDto(row.cosmetic)]),
    );
    const forest = Object.fromEntries(
      FOREST_SLOTS.map((slot) => [slot, bySlot.get(slot) ?? null]),
    ) as EquipmentResponse['forest'];
    return { forest, profileFrame: bySlot.get('profile_frame') ?? null };
  }

  /**
   * Puts an owned cosmetic of the slot's type in the slot, replacing what was there. Atomic and
   * idempotent, under the user's row lock. Ownership is never changed.
   */
  async equip(userId: string, slot: string, cosmeticId: string): Promise<EquipmentResponse> {
    const valid = validSlot(slot);
    await this.achievements.reconcile(userId);
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const { cosmetic, owned } = await this.ownership.ownsCosmetic(userId, cosmeticId, tx);
      const check = checkEquip(valid, cosmetic, owned);
      if (!check.ok) throw unprocessable(check.reason, EQUIP_MESSAGES[check.reason]);
      await tx.userEquipment.upsert({
        where: { userId_slot: { userId, slot: valid } },
        create: { userId, slot: valid, cosmeticId },
        update: { cosmeticId, equippedAt: this.clock.now() },
      });
    });
    return this.equipment(userId);
  }

  /** Empties the slot (the app shows its default). Idempotent. */
  async unequip(userId: string, slot: string): Promise<EquipmentResponse> {
    const valid = validSlot(slot);
    await this.prisma.userEquipment.deleteMany({ where: { userId, slot: valid } });
    return this.equipment(userId);
  }
}

function validSlot(slot: string): EquipmentSlot {
  if (!isEquipmentSlot(slot)) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message:
        'The slot must be one of: background, decoration, fauna, weather, effect, profile_frame.',
      code: 'invalid_slot',
    });
  }
  return slot;
}
