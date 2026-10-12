import { Injectable } from '@nestjs/common';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RelationshipResponse, UserCardResponse } from './dto/social.dto.js';
import {
  canSee,
  PRIVACY_CATEGORIES,
  PRIVACY_DEFAULTS,
  relationOf,
  type PrivacyCategory,
  type PrivacyLevel,
  type PrivacySettingsValues,
  type Relation,
} from './visibility.js';

/** A viewer looking at another user, with everything the privacy policy needs. */
export interface Viewing {
  relation: Exclude<Relation, 'blocked'>;
  relationship: RelationshipResponse;
  settings: PrivacySettingsValues;
  owner: {
    id: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    bio: string | null;
    createdAt: Date;
  };
}

/** A5.8 Someone who may appear on a leaderboard, and whether the viewer and they block each other. */
export interface BoardCandidate {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  blocked: boolean;
}

interface ViewRow {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  created_at: Date;
  status: string;
  profile: PrivacyLevel | null;
  forest: PrivacyLevel | null;
  statistics: PrivacyLevel | null;
  badges: PrivacyLevel | null;
  current_tree: PrivacyLevel | null;
  following: boolean;
  followed_by: boolean;
  blocked: boolean;
}

/**
 * A5.1: the one gate for cross-user reads (docs/06 PrivacySettings: "enforced by the backend on
 * every cross-user read"). A missing, suspended, or blocked user (either direction) is invisible
 * as a whole, the same as one that does not exist.
 */
@Injectable()
export class VisibilityService {
  constructor(private readonly prisma: PrismaService) {}

  /** Null when the viewer may not see the owner at all. */
  async view(viewerId: string, ownerId: string): Promise<Viewing | null> {
    const [row] = await this.prisma.$queryRaw<ViewRow[]>`
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.created_at, u.status::text,
             ps.profile::text, ps.forest::text, ps.statistics::text, ps.badges::text,
             ps.current_tree::text,
             EXISTS (SELECT 1 FROM follows
                     WHERE follower_id = ${viewerId}::uuid AND followee_id = u.id) AS following,
             EXISTS (SELECT 1 FROM follows
                     WHERE follower_id = u.id AND followee_id = ${viewerId}::uuid) AS followed_by,
             EXISTS (SELECT 1 FROM blocks
                     WHERE (blocker_id = ${viewerId}::uuid AND blocked_id = u.id)
                        OR (blocker_id = u.id AND blocked_id = ${viewerId}::uuid)) AS blocked
      FROM users u
      LEFT JOIN privacy_settings ps ON ps.user_id = u.id
      WHERE u.id = ${ownerId}::uuid`;
    if (!row || row.status !== 'active') return null;

    const self = row.id === viewerId;
    const relation = relationOf({
      self,
      blocked: row.blocked,
      following: row.following,
      followedBy: row.followed_by,
    });
    if (relation === 'blocked') return null;
    return {
      relation,
      relationship: relationship(row.following, row.followed_by),
      settings: settingsOf(row),
      owner: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        bio: row.bio,
        createdAt: row.created_at,
      },
    };
  }

  can(viewing: Viewing, category: PrivacyCategory): boolean {
    return canSee(viewing.settings[category], viewing.relation);
  }

  /** The user card: identity, the profile when visible, and what each category lets the viewer see. */
  card(viewing: Viewing): UserCardResponse {
    const profile = this.can(viewing, 'profile');
    return {
      id: viewing.owner.id,
      username: viewing.owner.username,
      displayName: viewing.owner.displayName,
      avatarUrl: viewing.owner.avatarUrl,
      bio: profile ? viewing.owner.bio : null,
      joinDate: profile ? viewing.owner.createdAt.toISOString() : null,
      relationship: viewing.relationship,
      visible: Object.fromEntries(
        PRIVACY_CATEGORIES.map((category) => [category, this.can(viewing, category)]),
      ) as UserCardResponse['visible'],
    };
  }

  /**
   * A5.8 The people a leaderboard may show: opted in (`leaderboards`, off by default) and active.
   * Friends: the viewer and their mutual follows; event: its participants; global: everyone.
   * `blocked` marks a block either way: never shown as a row (teams still count them as members,
   * so a team's score is the same for every viewer). Accounts staff excluded (A6.5) are never
   * candidates. Staff look without a viewer (`null`): no friends board, nobody blocked.
   */
  async boardCandidates(
    viewerId: string | null,
    scope: 'friends' | 'global' | 'event',
    eventId: string | null,
  ): Promise<BoardCandidate[]> {
    const inScope =
      scope === 'friends'
        ? Prisma.sql`AND (u.id = ${viewerId}::uuid OR (
            EXISTS (SELECT 1 FROM follows WHERE follower_id = ${viewerId}::uuid AND followee_id = u.id)
            AND EXISTS (SELECT 1 FROM follows WHERE follower_id = u.id AND followee_id = ${viewerId}::uuid)))`
        : scope === 'event'
          ? Prisma.sql`AND EXISTS (SELECT 1 FROM event_participations
                                   WHERE user_id = u.id AND event_id = ${eventId})`
          : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        username: string | null;
        display_name: string | null;
        avatar_url: string | null;
        blocked: boolean;
      }[]
    >`
      SELECT u.id::text, u.username, u.display_name, u.avatar_url,
             EXISTS (SELECT 1 FROM blocks
                     WHERE (blocker_id = ${viewerId}::uuid AND blocked_id = u.id)
                        OR (blocker_id = u.id AND blocked_id = ${viewerId}::uuid)) AS blocked
      FROM users u
      JOIN privacy_settings ps ON ps.user_id = u.id AND ps.leaderboards
      WHERE u.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM leaderboard_exclusions x WHERE x.user_id = u.id)
        ${inScope}`;
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      blocked: row.blocked,
    }));
  }

  /** How the viewer and each listed user follow each other, in two statements. */
  async relationships(
    viewerId: string,
    userIds: readonly string[],
  ): Promise<Map<string, RelationshipResponse>> {
    const ids = [...new Set(userIds)];
    const [outgoing, incoming] = await Promise.all([
      this.prisma.follow.findMany({
        where: { followerId: viewerId, followeeId: { in: ids } },
        select: { followeeId: true },
      }),
      this.prisma.follow.findMany({
        where: { followeeId: viewerId, followerId: { in: ids } },
        select: { followerId: true },
      }),
    ]);
    const following = new Set(outgoing.map((row) => row.followeeId));
    const followedBy = new Set(incoming.map((row) => row.followerId));
    return new Map(ids.map((id) => [id, relationship(following.has(id), followedBy.has(id))]));
  }
}

export function relationship(following: boolean, followedBy: boolean): RelationshipResponse {
  return { following, followedBy, friends: following && followedBy };
}

function settingsOf(row: ViewRow): PrivacySettingsValues {
  return {
    profile: row.profile ?? PRIVACY_DEFAULTS.profile,
    forest: row.forest ?? PRIVACY_DEFAULTS.forest,
    statistics: row.statistics ?? PRIVACY_DEFAULTS.statistics,
    badges: row.badges ?? PRIVACY_DEFAULTS.badges,
    currentTree: row.current_tree ?? PRIVACY_DEFAULTS.currentTree,
  };
}
