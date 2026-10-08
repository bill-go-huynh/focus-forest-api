import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { Prisma } from '../generated/prisma/client.js';
import { parseUsernamePrefix } from '../identity/username.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  BlockedUserResponse,
  PageResponse,
  UserCardResponse,
  UserSummaryResponse,
} from './dto/social.dto.js';
import { decodeSocialCursor, encodeSocialCursor, type SocialPosition } from './social-cursor.js';
import { relationship, VisibilityService } from './visibility.service.js';
import { PRIVACY_CATEGORIES } from './visibility.js';

const PAGE = 50;
const SEARCH_LIMIT = 20;

type Tx = Prisma.TransactionClient;

interface ListedRow {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  listed_at: Date;
}

/**
 * A5.1 follow graph and blocks (docs/06 Follow, Block; spec §13.1, §19.2). Follows need no
 * approval. A block deletes the follows between the two users and refuses new ones both ways.
 * A follow and a block of the same pair are serialized by a transaction-scoped advisory lock,
 * and a database trigger refuses any follow next to a block.
 */
@Injectable()
export class SocialGraphService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: VisibilityService,
    private readonly clock: Clock,
  ) {}

  async follow(viewerId: string, targetId: string): Promise<UserSummaryResponse> {
    if (viewerId === targetId) {
      throw unprocessable('cannot_follow_self', 'You cannot follow yourself.');
    }
    return this.prisma.$transaction(async (tx) => {
      await lockPair(tx, viewerId, targetId);
      const target = await tx.user.findUnique({
        where: { id: targetId },
        select: { id: true, username: true, displayName: true, avatarUrl: true, status: true },
      });
      if (
        !target ||
        target.status !== 'active' ||
        (await blockedEitherWay(tx, viewerId, targetId))
      ) {
        throw userNotFound();
      }
      await tx.follow.createMany({
        data: [{ followerId: viewerId, followeeId: targetId, createdAt: this.clock.now() }],
        skipDuplicates: true,
      });
      const followedBy =
        (await tx.follow.count({ where: { followerId: targetId, followeeId: viewerId } })) > 0;
      return {
        id: target.id,
        username: target.username,
        displayName: target.displayName,
        avatarUrl: target.avatarUrl,
        relationship: relationship(true, followedBy),
      };
    });
  }

  async unfollow(viewerId: string, targetId: string): Promise<void> {
    await this.prisma.follow.deleteMany({ where: { followerId: viewerId, followeeId: targetId } });
  }

  /** "Remove friend" (spec §13.1): the other user stops following the viewer. */
  async removeFollower(viewerId: string, followerId: string): Promise<void> {
    await this.prisma.follow.deleteMany({ where: { followerId, followeeId: viewerId } });
  }

  async block(viewerId: string, targetId: string): Promise<void> {
    if (viewerId === targetId) {
      throw unprocessable('cannot_block_self', 'You cannot block yourself.');
    }
    await this.prisma.$transaction(async (tx) => {
      await lockPair(tx, viewerId, targetId);
      // Any existing account can be blocked, a suspended one included.
      const exists = await tx.user.count({ where: { id: targetId } });
      if (exists === 0) throw userNotFound();
      await tx.block.createMany({
        data: [{ blockerId: viewerId, blockedId: targetId, createdAt: this.clock.now() }],
        skipDuplicates: true,
      });
      await tx.follow.deleteMany({
        where: {
          OR: [
            { followerId: viewerId, followeeId: targetId },
            { followerId: targetId, followeeId: viewerId },
          ],
        },
      });
    });
  }

  /** Unblocking restores no follow. */
  async unblock(viewerId: string, targetId: string): Promise<void> {
    await this.prisma.block.deleteMany({ where: { blockerId: viewerId, blockedId: targetId } });
  }

  async card(viewerId: string, targetId: string): Promise<UserCardResponse> {
    const viewing = await this.visibility.view(viewerId, targetId);
    if (!viewing) throw userNotFound();
    const profile = this.visibility.can(viewing, 'profile');
    return {
      id: viewing.owner.id,
      username: viewing.owner.username,
      displayName: viewing.owner.displayName,
      avatarUrl: viewing.owner.avatarUrl,
      bio: profile ? viewing.owner.bio : null,
      joinDate: profile ? viewing.owner.createdAt.toISOString() : null,
      relationship: viewing.relationship,
      visible: Object.fromEntries(
        PRIVACY_CATEGORIES.map((category) => [category, this.visibility.can(viewing, category)]),
      ) as UserCardResponse['visible'],
    };
  }

  /** Usernames starting with `q`: exact match first, then alphabetical. */
  async search(viewerId: string, q: string): Promise<PageResponse<UserSummaryResponse>> {
    const prefix = parseUsernamePrefix(q);
    if (prefix === null) {
      throw new BadRequestException('Search with 1–20 letters, digits, or underscores.');
    }
    const rows = await this.prisma.$queryRaw<ListedRow[]>`
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.created_at AS listed_at
      FROM users u
      WHERE u.username IS NOT NULL
        AND starts_with(u.username, ${prefix})
        AND u.status = 'active'
        AND u.id <> ${viewerId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
          WHERE (b.blocker_id = ${viewerId}::uuid AND b.blocked_id = u.id)
             OR (b.blocker_id = u.id AND b.blocked_id = ${viewerId}::uuid))
      ORDER BY (u.username = ${prefix}) DESC, u.username ASC
      LIMIT ${SEARCH_LIMIT}`;
    return { items: await this.summaries(viewerId, rows), nextCursor: null };
  }

  following(viewerId: string, cursor?: string): Promise<PageResponse<UserSummaryResponse>> {
    return this.followList(viewerId, 'following', cursor);
  }

  followers(viewerId: string, cursor?: string): Promise<PageResponse<UserSummaryResponse>> {
    return this.followList(viewerId, 'followers', cursor);
  }

  async blocks(viewerId: string, cursor?: string): Promise<PageResponse<BlockedUserResponse>> {
    const after = position(cursor);
    const rows = await this.prisma.$queryRaw<ListedRow[]>`
      SELECT u.id, u.username, u.display_name, u.avatar_url, b.created_at AS listed_at
      FROM blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = ${viewerId}::uuid ${afterClause('b.created_at', after)}
      ORDER BY b.created_at DESC, u.id DESC
      LIMIT ${PAGE + 1}`;
    const page = rows.slice(0, PAGE);
    return {
      items: page.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        blockedAt: row.listed_at.toISOString(),
      })),
      nextCursor: nextCursor(rows, page),
    };
  }

  /** Suspended users are left out of lists; their follows are kept for a reactivation. */
  private async followList(
    viewerId: string,
    direction: 'following' | 'followers',
    cursor?: string,
  ): Promise<PageResponse<UserSummaryResponse>> {
    const after = position(cursor);
    const [mine, theirs] =
      direction === 'following'
        ? [Prisma.sql`f.follower_id`, Prisma.sql`f.followee_id`]
        : [Prisma.sql`f.followee_id`, Prisma.sql`f.follower_id`];
    const rows = await this.prisma.$queryRaw<ListedRow[]>`
      SELECT u.id, u.username, u.display_name, u.avatar_url, f.created_at AS listed_at
      FROM follows f JOIN users u ON u.id = ${theirs}
      WHERE ${mine} = ${viewerId}::uuid AND u.status = 'active'
        ${afterClause('f.created_at', after)}
      ORDER BY f.created_at DESC, u.id DESC
      LIMIT ${PAGE + 1}`;
    const page = rows.slice(0, PAGE);
    return { items: await this.summaries(viewerId, page), nextCursor: nextCursor(rows, page) };
  }

  private async summaries(viewerId: string, rows: ListedRow[]): Promise<UserSummaryResponse[]> {
    const relationships = await this.visibility.relationships(
      viewerId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      relationship: relationships.get(row.id) ?? relationship(false, false),
    }));
  }
}

/** One lock per unordered pair of users, held until the transaction ends. */
async function lockPair(tx: Tx, a: string, b: string): Promise<void> {
  const key = a < b ? `social:${a}:${b}` : `social:${b}:${a}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
}

async function blockedEitherWay(tx: Tx, a: string, b: string): Promise<boolean> {
  const count = await tx.block.count({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
  });
  return count > 0;
}

function position(cursor: string | undefined): SocialPosition | null {
  if (cursor === undefined) return null;
  const decoded = decodeSocialCursor(cursor);
  if (!decoded) throw new BadRequestException('cursor is not valid.');
  return decoded;
}

function afterClause(column: 'f.created_at' | 'b.created_at', after: SocialPosition | null) {
  if (!after) return Prisma.empty;
  return Prisma.sql`AND (${Prisma.raw(column)}, u.id) < (${after.createdAt}, ${after.userId}::uuid)`;
}

function nextCursor(rows: ListedRow[], page: ListedRow[]): string | null {
  const last = page.at(-1);
  if (rows.length <= page.length || !last) return null;
  return encodeSocialCursor({ createdAt: last.listed_at, userId: last.id });
}

/** The same answer for a missing, suspended, or blocking user: a block is never revealed. */
function userNotFound(): NotFoundException {
  return new NotFoundException('User not found.');
}

function unprocessable(code: string, message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message,
    code,
  });
}
