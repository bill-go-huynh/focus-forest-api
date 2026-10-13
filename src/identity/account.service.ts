import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { UsageDataExport } from '../analytics/usage-data-export.js';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordHasher } from './password-hasher.js';

type Row = Record<string, unknown>;

/** Dates as ISO 8601, big integers as numbers, the owner's id left out (it is the account's). */
function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'userId')
        .map(([key, item]) => [key, plain(item)]),
    );
  }
  return value;
}
const rows = (items: readonly object[]) => items.map((item) => plain(item) as Row);

/**
 * A7.1 The person's own account (docs/11 Privacy; Phase 7 owner decision 3): a copy of
 * everything stored about them, and deletion at once, confirmed by their password.
 *
 * Deletion removes the user row; the database cascades every row the person owns (sessions,
 * notes, trees, rewards, follows, blocks, reactions, devices, tokens, rooms, challenges, events).
 * Shared records keep only what others need, without the person: Community Tree contributions
 * and totals (anonymous), reports they filed (for moderators), challenges they created. There is
 * no admin audit entry: nobody but the person acted.
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordHasher,
    private readonly clock: Clock,
    private readonly usage: UsageDataExport,
  ) {}

  async delete(userId: string, password: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user) throw new NotFoundException('This account does not exist.');
    if (!(await this.passwords.verify(password, user.passwordHash))) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'That password is not right.',
        code: 'password_incorrect',
      });
    }
    // deleteMany: a second, concurrent request finds nothing left and still succeeds.
    await this.prisma.user.deleteMany({ where: { id: userId } });
  }

  /**
   * Everything stored about the person, in sections. Never secrets (password hash, token
   * hashes, push tokens) and never another person's private data: who blocked them, reports
   * about them (they would name the reporter), or other people's emails.
   */
  async export(userId: string): Promise<Row> {
    const p = this.prisma;
    const where = { where: { userId } };
    const user = await p.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        bio: true,
        avatarUrl: true,
        timezone: true,
        hemisphere: true,
        status: true,
        createdAt: true,
      },
    });
    const [
      settings,
      notificationPreferences,
      privacy,
      topics,
      sessions,
      dailyGoals,
      weeklyGoals,
      restDays,
      recoveries,
      trees,
      traits,
      recaps,
      areas,
      badges,
      showcase,
      species,
      cosmetics,
      equipment,
      following,
      followers,
      blocked,
      reactionsGiven,
      reactionsReceived,
      rooms,
      invitesReceived,
      invitesSent,
      challenges,
      events,
      contributions,
      milestoneGrants,
      communityGrants,
      devices,
      notifications,
      analytics,
      reportsFiled,
      warnings,
    ] = await Promise.all([
      p.userPreferences.findUnique(where),
      p.notificationPreference.findMany({ ...where, orderBy: { category: 'asc' } }),
      p.privacySettings.findUnique(where),
      p.topic.findMany({
        ...where,
        omit: { createFingerprint: true },
        orderBy: { createdAt: 'asc' },
      }),
      p.focusSession.findMany({
        ...where,
        select: {
          id: true,
          topicId: true,
          startedAt: true,
          submittedEndedAt: true,
          plannedMinutes: true,
          pauseIntervals: true,
          focusedMilliseconds: true,
          pausedMilliseconds: true,
          status: true,
          localDate: true,
          note: true,
          noteHighlighted: true,
          createdAt: true,
        },
        orderBy: { startedAt: 'asc' },
      }),
      p.dailyGoalSetting.findMany(where),
      p.weeklyGoalSetting.findMany(where),
      p.restDay.findMany(where),
      p.streakRecovery.findMany(where),
      p.monthlyTree.findMany({ ...where, orderBy: [{ year: 'asc' }, { month: 'asc' }] }),
      p.monthlyTreeTrait.findMany(where),
      p.monthlyRecap.findMany(where),
      p.forestAreaUnlock.findMany(where),
      p.userBadge.findMany(where),
      p.badgeShowcase.findMany(where),
      p.userSpecies.findMany(where),
      p.userCosmetic.findMany(where),
      p.userEquipment.findMany(where),
      p.follow.findMany({
        where: { followerId: userId },
        select: { followeeId: true, createdAt: true },
      }),
      p.follow.findMany({
        where: { followeeId: userId },
        select: { followerId: true, createdAt: true },
      }),
      p.block.findMany({
        where: { blockerId: userId },
        select: { blockedId: true, createdAt: true },
      }),
      p.reaction.findMany({
        where: { reactorId: userId },
        select: {
          ownerId: true,
          targetType: true,
          targetKey: true,
          reaction: true,
          createdAt: true,
        },
      }),
      // The app shows who reacted, so the copy does too.
      p.reaction.findMany({
        where: { ownerId: userId },
        select: {
          reactorId: true,
          targetType: true,
          targetKey: true,
          reaction: true,
          createdAt: true,
        },
      }),
      p.roomParticipant.findMany(where),
      p.roomInvite.findMany({ where: { inviteeId: userId } }),
      p.roomInvite.findMany({ where: { inviterId: userId } }),
      p.challengeParticipant.findMany(where),
      p.eventParticipation.findMany(where),
      p.communityContribution.findMany({
        ...where,
        select: { eventId: true, sessionId: true, minutes: true, contributedAt: true },
      }),
      p.eventMilestoneGrant.findMany(where),
      p.communityRewardGrant.findMany(where),
      p.pushDevice.findMany({
        ...where,
        select: { platform: true, appVersion: true, registeredAt: true, lastSeenAt: true },
      }),
      p.notificationOutbox.findMany({
        ...where,
        select: {
          category: true,
          title: true,
          body: true,
          link: true,
          status: true,
          reason: true,
          notBefore: true,
          sentAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.usage.of(userId),
      p.report.findMany({
        where: { reporterId: userId },
        select: { targetId: true, category: true, details: true, status: true, createdAt: true },
      }),
      p.userWarning.findMany({
        ...where,
        select: { message: true, createdAt: true, acknowledgedAt: true },
      }),
    ]);

    return {
      exportedAt: this.clock.now().toISOString(),
      account: plain(user),
      preferences: {
        settings: settings && plain(settings),
        notifications: rows(notificationPreferences),
        privacy: privacy && plain(privacy),
      },
      topics: rows(topics),
      sessions: rows(sessions),
      goals: {
        daily: rows(dailyGoals),
        weekly: rows(weeklyGoals),
        restDays: rows(restDays),
        recoveries: rows(recoveries),
      },
      trees: {
        months: rows(trees),
        traits: rows(traits),
        recaps: rows(recaps),
        forestAreas: rows(areas),
      },
      rewards: {
        badges: rows(badges),
        showcase: rows(showcase),
        species: rows(species),
        cosmetics: rows(cosmetics),
        equipment: rows(equipment),
      },
      social: {
        following: following.map((f) => ({
          userId: f.followeeId,
          createdAt: f.createdAt.toISOString(),
        })),
        followers: followers.map((f) => ({
          userId: f.followerId,
          createdAt: f.createdAt.toISOString(),
        })),
        blocked: blocked.map((b) => ({
          userId: b.blockedId,
          createdAt: b.createdAt.toISOString(),
        })),
        reactionsGiven: reactionsGiven.map(({ ownerId, ...r }) => ({
          toUserId: ownerId,
          ...(plain(r) as Row),
        })),
        reactionsReceived: reactionsReceived.map(({ reactorId, ...r }) => ({
          fromUserId: reactorId,
          ...(plain(r) as Row),
        })),
      },
      together: {
        rooms: rows(rooms),
        roomInvitesReceived: rows(invitesReceived),
        roomInvitesSent: rows(invitesSent),
        challenges: rows(challenges),
        events: rows(events),
        communityContributions: rows(contributions),
        eventMilestones: rows(milestoneGrants),
        communityRewards: rows(communityGrants),
      },
      notifications: { devices: rows(devices), sent: rows(notifications) },
      analytics,
      moderation: { reportsFiled: rows(reportsFiled), warnings: rows(warnings) },
    };
  }
}
