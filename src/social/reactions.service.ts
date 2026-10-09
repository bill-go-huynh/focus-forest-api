import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  PageResponse,
  ReactionReceivedResponse,
  ReactionSummaryResponse,
} from './dto/social.dto.js';
import { blockedEitherWay, lockPair } from './pair-lock.js';
import {
  formatReactionTarget,
  REACTIONS,
  type ReactionKindId,
  type ReactionTarget,
} from './reaction-target.js';
import { decodeSocialCursor, encodeSocialCursor } from './social-cursor.js';
import { VisibilityService } from './visibility.service.js';

const PAGE = 50;

interface ReceivedRow {
  id: string;
  reaction: ReactionKindId;
  target_type: string;
  target_key: string;
  created_at: Date;
  reactor_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

/**
 * A5.2 reactions (docs/06 Reaction, spec §13.4): the table's only writer. Whether the viewer may
 * react to a target (privacy, existence) is decided by the caller through the visibility gate;
 * this checks the relationship itself under the pair lock, so a block always wins.
 */
@Injectable()
export class ReactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: VisibilityService,
    private readonly clock: Clock,
  ) {}

  async add(
    reactorId: string,
    ownerId: string,
    target: ReactionTarget,
    reaction: ReactionKindId,
  ): Promise<ReactionSummaryResponse> {
    await this.prisma.$transaction(async (tx) => {
      await lockPair(tx, reactorId, ownerId);
      if (await blockedEitherWay(tx, reactorId, ownerId)) throw userNotFound();
      await tx.reaction.createMany({
        data: [
          {
            reactorId,
            ownerId,
            targetType: target.type,
            targetKey: target.key,
            reaction,
            createdAt: this.clock.now(),
          },
        ],
        skipDuplicates: true,
      });
    });
    return this.summary(reactorId, ownerId, target);
  }

  async remove(
    reactorId: string,
    ownerId: string,
    target: ReactionTarget,
    reaction: ReactionKindId,
  ): Promise<ReactionSummaryResponse> {
    await this.prisma.reaction.deleteMany({
      where: { reactorId, ownerId, targetType: target.type, targetKey: target.key, reaction },
    });
    return this.summary(reactorId, ownerId, target);
  }

  /** Counts per kind from active reactors, and the viewer's own kinds. */
  async summary(
    viewerId: string,
    ownerId: string,
    target: ReactionTarget,
  ): Promise<ReactionSummaryResponse> {
    const rows = await this.prisma.reaction.findMany({
      where: {
        ownerId,
        targetType: target.type,
        targetKey: target.key,
        reactor: { status: 'active' },
      },
      select: { reactorId: true, reaction: true },
    });
    const counts = Object.fromEntries(REACTIONS.map((kind) => [kind, 0])) as Record<
      ReactionKindId,
      number
    >;
    for (const row of rows) counts[row.reaction] += 1;
    const mine = new Set(
      rows.filter((row) => row.reactorId === viewerId).map((row) => row.reaction),
    );
    return {
      target: formatReactionTarget(target),
      counts,
      mine: REACTIONS.filter((kind) => mine.has(kind)),
    };
  }

  /** The reactions the owner received, newest first, without suspended reactors. */
  async received(
    ownerId: string,
    cursor?: string,
  ): Promise<PageResponse<ReactionReceivedResponse>> {
    const after = cursor === undefined ? null : decodeSocialCursor(cursor);
    if (cursor !== undefined && !after) throw new BadRequestException('cursor is not valid.');
    const rows = await this.prisma.$queryRaw<ReceivedRow[]>`
      SELECT r.id, r.reaction::text AS reaction, r.target_type::text AS target_type, r.target_key,
             r.created_at, u.id AS reactor_id, u.username, u.display_name, u.avatar_url
      FROM reactions r JOIN users u ON u.id = r.reactor_id
      WHERE r.owner_id = ${ownerId}::uuid AND u.status = 'active'
        ${after ? Prisma.sql`AND (r.created_at, r.id) < (${after.createdAt}, ${after.id}::uuid)` : Prisma.empty}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${PAGE + 1}`;
    const page = rows.slice(0, PAGE);
    const relationships = await this.visibility.relationships(
      ownerId,
      page.map((row) => row.reactor_id),
    );
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        reaction: row.reaction,
        target: formatReactionTarget({ type: row.target_type, key: row.target_key }),
        createdAt: row.created_at.toISOString(),
        from: {
          id: row.reactor_id,
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          relationship: relationships.get(row.reactor_id)!,
        },
      })),
      nextCursor:
        rows.length > page.length && last
          ? encodeSocialCursor({ createdAt: last.created_at, id: last.id })
          : null,
    };
  }
}

function userNotFound(): NotFoundException {
  return new NotFoundException('User not found.');
}
