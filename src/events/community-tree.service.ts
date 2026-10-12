import { Injectable, NotFoundException } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import type { Prisma } from '../generated/prisma/client.js';
import { JobsService } from '../jobs/jobs.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toBadgeDto, toCosmeticDto } from '../progression/badge.dto.js';
import { ProgressionOwnershipService } from '../progression/progression-ownership.service.js';
import {
  COMMUNITY_STAGES,
  type CommunityStage,
  type CommunityTreeDto,
  type CommunityTreeSummary,
  type SessionCommunityResult,
} from './community-tree.dto.js';
import { grantIfAcquirable } from './grant-reward.js';

type Client = PrismaService | Prisma.TransactionClient;

export const COMMUNITY_REACHED_JOB = 'community.reached';

const WITH_MILESTONES = {
  milestones: {
    orderBy: { thresholdMinutes: 'asc' as const },
    include: { badge: true, cosmetic: true },
  },
} satisfies Prisma.CommunityTreeInclude;

/**
 * A5.7 Community Tree (spec §12, docs/06 CommunityTree). The shared tree of an event grows from
 * its participants' counted focus in the window, through an append-only ledger that outlives the
 * accounts that made it. The tree row is the one serialization point: a contribution locks it,
 * so the total and the milestones it reaches stay correct under concurrent sessions. Every
 * participant shares each milestone's reward, whatever they contributed (docs/02).
 */
@Injectable()
export class CommunityTreeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: ProgressionOwnershipService,
    private readonly clock: Clock,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Adds the participant's counted sessions of the window not yet in the ledger, in a transaction
   * holding the user's lock: on joining, all of them; on a submission, that session (and any the
   * ledger missed, so none is ever left out). Null without a tree.
   */
  async contribute(
    tx: Prisma.TransactionClient,
    userId: string,
    event: { id: string; startsAt: Date; endsAt: Date },
  ): Promise<SessionCommunityResult | null> {
    const locked = await tx.$queryRaw<{ total_minutes: bigint }[]>`
      SELECT total_minutes FROM community_trees WHERE event_id = ${event.id} FOR UPDATE`;
    if (locked.length === 0) return null;
    const now = this.clock.now();
    const added = await tx.$queryRaw<{ minutes: number }[]>`
      INSERT INTO community_contributions (event_id, user_id, session_id, minutes, contributed_at)
      SELECT ${event.id}, user_id, id, focused_milliseconds / 60000, ${now}
      FROM focus_sessions
      WHERE user_id = ${userId}::uuid AND status <> 'discarded'
        AND started_at >= ${event.startsAt} AND started_at < ${event.endsAt}
        AND focused_milliseconds >= 60000
      ON CONFLICT DO NOTHING
      RETURNING minutes`;
    const minutes = added.reduce((sum, row) => sum + row.minutes, 0);
    let total = Number(locked[0]!.total_minutes);
    if (minutes > 0) {
      const [row] = await tx.$queryRaw<{ total_minutes: bigint }[]>`
        UPDATE community_trees SET total_minutes = total_minutes + ${minutes}
        WHERE event_id = ${event.id} RETURNING total_minutes`;
      total = Number(row!.total_minutes);
    }
    const reached = await tx.$queryRaw<{ stage: CommunityStage }[]>`
      UPDATE community_milestones SET reached_at = ${now}
      WHERE event_id = ${event.id} AND reached_at IS NULL AND threshold_minutes <= ${total}
      RETURNING stage::text AS stage`;
    if (reached.length > 0) {
      // The other participants hear of it after the commit (A6.3, `EventNoticesService`).
      await this.jobs.enqueue(tx, {
        kind: COMMUNITY_REACHED_JOB,
        runAt: now,
        payload: {
          eventId: event.id,
          stages: reached.map((row) => row.stage),
          contributorId: userId,
        },
      });
    }
    return {
      minutes,
      totalMinutes: total,
      reachedStages: inStageOrder(reached.map((row) => row.stage)),
    };
  }

  /**
   * Grants a participant the shared rewards of the milestones reached and not yet granted. The
   * grant's key decides under concurrency: only the call that creates it grants the reward.
   */
  async reconcile(client: Client, userId: string, eventId: string): Promise<void> {
    const reached = await client.communityMilestone.findMany({
      where: { eventId, reachedAt: { not: null } },
    });
    if (reached.length === 0) return;
    const now = this.clock.now();
    const created = await client.communityRewardGrant.createManyAndReturn({
      data: reached.map((milestone) => ({
        userId,
        eventId,
        stage: milestone.stage,
        grantedAt: now,
      })),
      skipDuplicates: true,
    });
    const createdStages = new Set(created.map((row) => row.stage));
    for (const milestone of reached.filter((m) => createdStages.has(m.stage))) {
      if (milestone.badgeId) {
        await grantIfAcquirable(this.ownership, 'badge', userId, milestone.badgeId, now, client);
      }
      if (milestone.cosmeticId) {
        await grantIfAcquirable(
          this.ownership,
          'cosmetic',
          userId,
          milestone.cosmeticId,
          now,
          client,
        );
      }
    }
  }

  /** The tree as anyone who can see the event sees it; the shared rewards for a participant. */
  async view(userId: string, eventId: string, joined: boolean): Promise<CommunityTreeDto> {
    if (joined) await this.reconcile(this.prisma, userId, eventId);
    const tree = await this.prisma.communityTree.findUnique({
      where: { eventId },
      include: WITH_MILESTONES,
    });
    if (!tree) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'This event has no Community Tree.',
        code: 'community_tree_not_found',
      });
    }
    const [participants, yours, grants] = await Promise.all([
      this.prisma.eventParticipation.count({ where: { eventId } }),
      joined
        ? this.prisma.communityContribution.aggregate({
            where: { eventId, userId },
            _sum: { minutes: true },
          })
        : null,
      this.prisma.communityRewardGrant.findMany({
        where: { userId, eventId, celebratedAt: null },
        select: { stage: true },
      }),
    ]);
    const toCelebrate = new Set(grants.map((grant) => grant.stage));
    return {
      eventId,
      name: tree.name,
      artworkId: tree.artworkId,
      stage: currentStage(tree.milestones),
      totalMinutes: Number(tree.totalMinutes),
      participants,
      joined,
      yourMinutes: yours ? (yours._sum.minutes ?? 0) : null,
      milestones: tree.milestones.map((milestone) => ({
        stage: milestone.stage,
        thresholdMinutes: Number(milestone.thresholdMinutes),
        reached: milestone.reachedAt !== null,
        reachedAt: milestone.reachedAt?.toISOString() ?? null,
        rewards: {
          badge: milestone.badge ? toBadgeDto(milestone.badge) : null,
          cosmetic: milestone.cosmetic ? toCosmeticDto(milestone.cosmetic) : null,
        },
      })),
      celebrate: tree.milestones.map((m) => m.stage).filter((stage) => toCelebrate.has(stage)),
    };
  }

  /** The stage and total shown with the event, or null without a tree. */
  async summary(eventId: string): Promise<CommunityTreeSummary | null> {
    const tree = await this.prisma.communityTree.findUnique({
      where: { eventId },
      include: { milestones: { orderBy: { thresholdMinutes: 'asc' } } },
    });
    if (!tree) return null;
    return { stage: currentStage(tree.milestones), totalMinutes: Number(tree.totalMinutes) };
  }

  /** Marks the named celebrations seen, once; a stage not granted is left alone. */
  async celebrated(userId: string, eventId: string, stages: CommunityStage[]): Promise<void> {
    await this.prisma.communityRewardGrant.updateMany({
      where: { userId, eventId, stage: { in: stages }, celebratedAt: null },
      data: { celebratedAt: this.clock.now() },
    });
  }
}

/** The highest stage reached, by threshold; null before the first. */
function currentStage(
  milestones: readonly { stage: CommunityStage; reachedAt: Date | null }[],
): CommunityStage | null {
  return milestones.filter((m) => m.reachedAt !== null).at(-1)?.stage ?? null;
}

function inStageOrder(stages: CommunityStage[]): CommunityStage[] {
  return COMMUNITY_STAGES.filter((stage) => stages.includes(stage));
}
