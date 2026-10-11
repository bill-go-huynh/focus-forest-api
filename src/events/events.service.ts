import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { DayFocus } from '../challenges/challenge-rules.js';
import { Clock } from '../common/clock.js';
import { addDays, type LocalDate } from '../common/local-date.js';
import { localDateFromDb } from '../consistency/db.js';
import { streakEndingOn, type ActivityHistory } from '../consistency/streak.js';
import { StreakService } from '../consistency/streak.service.js';
import { isCounted } from '../focus-stats/focus-stats.js';
import type { FocusSession, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toBadgeDto, toCosmeticDto } from '../progression/badge.dto.js';
import { ProgressionOwnershipService } from '../progression/progression-ownership.service.js';
import { localDateOf } from '../sessions/attribution/calendar.js';
import { MonthlyTreesService } from '../trees/monthly-trees.service.js';
import type { CommunityStage, CommunityTreeDto } from './community-tree.dto.js';
import { CommunityTreeService } from './community-tree.service.js';
import { eventPhase, missionValue, reachedMilestones, type MissionInput } from './event-rules.js';
import type { EventCardDto, EventDto, SessionEventResult } from './events.dto.js';
import { grantIfAcquirable } from './grant-reward.js';

type Client = PrismaService | Prisma.TransactionClient;

const WITH_CONTENT = {
  missions: { orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] },
  milestones: {
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
    include: { badge: true, cosmetic: true },
  },
} satisfies Prisma.EventInclude;
type LoadedEvent = Prisma.EventGetPayload<{ include: typeof WITH_CONTENT }>;

/**
 * A5.6 Events and missions (spec §11, docs/02 Events, docs/06 Event). Events are content (seed
 * data); joining is the user's choice. Missions are derived from the user's normal counted
 * sessions that started in the event window, whenever they joined: there is no event-only focus.
 * A milestone's rewards are granted once, to participants, and owned forever; its event trait
 * goes on the tree growing when it is reached (kept for later when there is none).
 */
@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: ProgressionOwnershipService,
    private readonly trees: MonthlyTreesService,
    private readonly streak: StreakService,
    private readonly community: CommunityTreeService,
    private readonly clock: Clock,
  ) {}

  /** Live and upcoming events, the soonest first. */
  async list(userId: string): Promise<{ items: EventDto[] }> {
    const now = this.clock.now();
    const events = await this.prisma.event.findMany({
      where: { status: 'active', endsAt: { gt: now } },
      include: WITH_CONTENT,
      orderBy: [{ startsAt: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    });
    const items: EventDto[] = [];
    for (const event of events) items.push(await this.view(userId, event));
    return { items };
  }

  async one(userId: string, eventId: string): Promise<EventDto> {
    const event = await this.visible(userId, eventId);
    return this.view(userId, event);
  }

  async join(userId: string, eventId: string): Promise<EventDto> {
    const event = await this.visible(userId, eventId);
    await this.prisma.$transaction(async (tx) => {
      // The user's lock, as a session submission takes it: a session submitted while joining is
      // added to the Community Tree exactly once, by this backfill or by its submission (A5.7).
      await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const joined = await tx.eventParticipation.findUnique({
        where: { userId_eventId: { userId, eventId } },
      });
      if (joined) return;
      if (eventPhase(event, this.clock.now()) === 'ended') {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: 'This event has ended.',
          code: 'event_ended',
        });
      }
      if (event.entryMinSessions > 0) {
        const counted = await tx.focusSession.count({
          where: { userId, status: { not: 'discarded' } },
        });
        if (counted < event.entryMinSessions) {
          throw new UnprocessableEntityException({
            statusCode: 422,
            error: 'Unprocessable Entity',
            message: `This event opens after ${event.entryMinSessions} focus sessions.`,
            code: 'event_entry_not_met',
          });
        }
      }
      await tx.eventParticipation.create({
        data: {
          userId,
          eventId,
          joinedAt: this.clock.now(),
          teamId: await smallestTeam(tx, eventId),
        },
      });
      // Focus already done in the window grows the shared tree too, as it counts for missions.
      await this.community.contribute(tx, userId, event);
    });
    return this.view(userId, event);
  }

  /**
   * In the session submission transaction, after achievements: the progress of every joined event
   * whose window holds the session's start, the missions it completed, and the milestones it
   * reached (whose rewards are granted now). Stored with the session for its replay.
   */
  async evaluateSession(
    tx: Prisma.TransactionClient,
    userId: string,
    session: FocusSession,
  ): Promise<SessionEventResult[]> {
    const events = await tx.event.findMany({
      where: {
        status: { not: 'planned' },
        startsAt: { lte: session.startedAt },
        endsAt: { gt: session.startedAt },
        participations: { some: { userId } },
      },
      include: WITH_CONTENT,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    const results: SessionEventResult[] = [];
    for (const event of events) {
      const after = await this.values(tx, userId, event);
      const before = isCounted(session.status)
        ? await this.values(tx, userId, event, session)
        : after;
      const reached = await this.reconcile(tx, userId, event, after, {
        year: session.year,
        month: session.month,
      });
      // A5.7: the session's minutes on the shared tree (tree rows lock in this event order), then
      // the shared rewards of every milestone reached so far.
      const community = await this.community.contribute(tx, userId, event);
      if (community) await this.community.reconcile(tx, userId, event.id);
      results.push({
        eventId: event.id,
        missions: event.missions.map((mission, i) => ({
          id: mission.id,
          value: after[i]!,
          target: mission.target,
          completed: after[i]! >= mission.target,
        })),
        newlyCompletedMissionIds: event.missions
          .filter((mission, i) => after[i]! >= mission.target && before[i]! < mission.target)
          .map((mission) => mission.id),
        newlyReachedMilestoneIds: reached,
        community,
      });
    }
    return results;
  }

  /** At most one quiet card for Home: a joined event first, else one to join (docs/02). */
  async homeCard(userId: string): Promise<EventCardDto | null> {
    const now = this.clock.now();
    const events = await this.prisma.event.findMany({
      where: { status: 'active', endsAt: { gt: now } },
      include: { ...WITH_CONTENT, participations: { where: { userId } } },
      orderBy: [{ startsAt: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    });
    const joined = events
      .filter((event) => event.participations.length > 0)
      .sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());
    const event = joined[0] ?? events[0];
    if (!event) return null;
    const isJoined = event.participations.length > 0;
    let missionsCompleted: number | null = null;
    if (isJoined) {
      const values = await this.values(this.prisma, userId, event);
      missionsCompleted = event.missions.filter((m, i) => values[i]! >= m.target).length;
    }
    return {
      id: event.id,
      name: event.name,
      artworkId: event.artworkId,
      phase: eventPhase(event, now),
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      joined: isJoined,
      missionsCompleted,
      missionsTotal: event.missions.length,
    };
  }

  /** A5.7 The event's Community Tree; a participant receives the shared rewards reached. */
  async communityTree(userId: string, eventId: string): Promise<CommunityTreeDto> {
    const event = await this.visible(userId, eventId);
    return this.community.view(userId, eventId, event.participations.length > 0);
  }

  async communityCelebrated(
    userId: string,
    eventId: string,
    stages: CommunityStage[],
  ): Promise<void> {
    await this.visible(userId, eventId);
    await this.community.celebrated(userId, eventId, stages);
  }

  /** Active events, and retired ones the user joined. Planned events do not exist yet. */
  private async visible(
    userId: string,
    eventId: string,
  ): Promise<LoadedEvent & { participations: unknown[] }> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: { ...WITH_CONTENT, participations: { where: { userId } } },
    });
    if (
      !event ||
      event.status === 'planned' ||
      (event.status === 'retired' && event.participations.length === 0)
    ) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'This event does not exist.',
        code: 'event_not_found',
      });
    }
    return event;
  }

  private async view(userId: string, event: LoadedEvent): Promise<EventDto> {
    const joined =
      (await this.prisma.eventParticipation.count({ where: { userId, eventId: event.id } })) > 0;
    const values = joined ? await this.values(this.prisma, userId, event) : null;
    if (values) await this.reconcile(this.prisma, userId, event, values);
    if (joined) await this.community.reconcile(this.prisma, userId, event.id);
    const granted = joined
      ? new Set(
          (
            await this.prisma.eventMilestoneGrant.findMany({
              where: { userId, eventId: event.id },
              select: { milestoneId: true },
            })
          ).map((row) => row.milestoneId),
        )
      : new Set<string>();
    return {
      id: event.id,
      name: event.name,
      description: event.description,
      artworkId: event.artworkId,
      phase: eventPhase(event, this.clock.now()),
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      joined,
      communityTree: await this.community.summary(event.id),
      missions: event.missions.map((mission, i) => ({
        id: mission.id,
        name: mission.name,
        description: mission.description,
        measure: mission.measure,
        target: mission.target,
        dailyMinutes: mission.dailyMinutes,
        value: values ? values[i]! : null,
        completed: values ? values[i]! >= mission.target : false,
      })),
      milestones: event.milestones.map((milestone) => ({
        id: milestone.id,
        name: milestone.name,
        requiredMissions: milestone.requiredMissions,
        reached: granted.has(milestone.id),
        rewards: {
          badge: milestone.badge ? toBadgeDto(milestone.badge) : null,
          cosmetic: milestone.cosmetic ? toCosmeticDto(milestone.cosmetic) : null,
          traitId: milestone.traitId,
        },
      })),
    };
  }

  /**
   * Grants the milestones reached and not yet granted (the grant's key decides under
   * concurrency: only the call that creates it grants the rewards), and places event traits still
   * waiting for a growing tree. Returns the milestones this call reached.
   */
  private async reconcile(
    client: Client,
    userId: string,
    event: LoadedEvent,
    values: readonly number[],
    sessionMonth?: { year: number; month: number },
  ): Promise<string[]> {
    const now = this.clock.now();
    const completed = event.missions.filter((m, i) => values[i]! >= m.target).length;
    const reachedIds = reachedMilestones(event.milestones, completed);
    const created =
      reachedIds.length === 0
        ? []
        : await client.eventMilestoneGrant.createManyAndReturn({
            data: reachedIds.map((milestoneId) => ({
              userId,
              eventId: event.id,
              milestoneId,
              reachedAt: now,
            })),
            skipDuplicates: true,
          });
    const createdIds = new Set(created.map((row) => row.milestoneId));
    for (const milestone of event.milestones.filter((m) => createdIds.has(m.id))) {
      // Rewards are acquired while their content is available; owned forever after.
      if (milestone.badge) {
        await grantIfAcquirable(this.ownership, 'badge', userId, milestone.badge.id, now, client);
      }
      if (milestone.cosmetic) {
        await grantIfAcquirable(
          this.ownership,
          'cosmetic',
          userId,
          milestone.cosmetic.id,
          now,
          client,
        );
      }
    }
    const waiting = await client.eventMilestoneGrant.findMany({
      where: { userId, eventId: event.id, traitYear: null, milestone: { traitId: { not: null } } },
      include: { milestone: true },
    });
    for (const grant of waiting) {
      const placed = await this.trees.placeTrait(
        client,
        userId,
        grant.milestone.traitId!,
        now,
        sessionMonth,
      );
      if (placed) {
        await client.eventMilestoneGrant.updateMany({
          where: { userId, eventId: event.id, milestoneId: grant.milestoneId, traitYear: null },
          data: { traitYear: placed.year, traitMonth: placed.month },
        });
      }
    }
    return event.milestones.filter((m) => createdIds.has(m.id)).map((m) => m.id);
  }

  /** Each mission's value, in mission order; `without` leaves one session out (the "before"). */
  private async values(
    client: Client,
    userId: string,
    event: LoadedEvent,
    without?: FocusSession,
  ): Promise<number[]> {
    const input = await this.input(client, userId, event, without);
    return event.missions.map((mission) => missionValue(mission, input));
  }

  private async input(
    client: Client,
    userId: string,
    event: LoadedEvent,
    without?: FocusSession,
  ): Promise<MissionInput> {
    const excluded = without?.id ?? null;
    const [dayRows, together, history, user] = await Promise.all([
      client.$queryRaw<{ local_date: Date; milliseconds: bigint; sessions: bigint }[]>`
        SELECT local_date, SUM(focused_milliseconds)::bigint AS milliseconds, COUNT(*) AS sessions
        FROM focus_sessions
        WHERE user_id = ${userId}::uuid AND status <> 'discarded'
          AND started_at >= ${event.startsAt} AND started_at < ${event.endsAt}
          AND (${excluded}::uuid IS NULL OR id <> ${excluded}::uuid)
        GROUP BY local_date`,
      client.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS count FROM room_participants rp
        JOIN focus_sessions fs ON fs.user_id = rp.user_id AND fs.id = rp.session_id
        WHERE rp.user_id = ${userId}::uuid
          AND fs.started_at >= ${event.startsAt} AND fs.started_at < ${event.endsAt}`,
      event.missions.some((m) => m.measure === 'streak_days')
        ? this.streak.history(userId, client)
        : null,
      client.user.findUniqueOrThrow({ where: { id: userId }, select: { timezone: true } }),
    ]);
    const days: DayFocus[] = dayRows.map((row) => ({
      date: localDateFromDb(row.local_date),
      minutes: Math.floor(Number(row.milliseconds) / 60_000),
      sessions: Number(row.sessions),
    }));
    let longestStreak = 0;
    if (history && user.timezone) {
      const withoutDay =
        without && !days.some((day) => day.date === localDateFromDb(without.localDate))
          ? withoutDate(history, localDateFromDb(without.localDate))
          : history;
      longestStreak = longestInWindow(withoutDay, event, user.timezone, this.clock.now());
    }
    return { days, togetherSessions: Number(together[0]?.count ?? 0), longestStreak };
  }
}

/**
 * A5.8 The team a new participant joins: the one with the fewest members (ties by sort order,
 * then id), so teams stay balanced. Null for an event without teams.
 */
async function smallestTeam(tx: Prisma.TransactionClient, eventId: string): Promise<string | null> {
  const teams = await tx.eventTeam.findMany({
    where: { eventId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { _count: { select: { participations: true } } },
  });
  let best: (typeof teams)[number] | null = null;
  for (const team of teams) {
    if (!best || team._count.participations < best._count.participations) best = team;
  }
  return best?.id ?? null;
}

function withoutDate(history: ActivityHistory, date: LocalDate): ActivityHistory {
  return { ...history, activeDates: history.activeDates.filter((d) => d !== date) };
}

/** The longest streak reached on any local date of the event window, up to today. */
function longestInWindow(
  history: ActivityHistory,
  event: { startsAt: Date; endsAt: Date },
  timeZone: string,
  now: Date,
): number {
  const first = localDateOf(event.startsAt, timeZone);
  const end = new Date(Math.min(now.getTime(), event.endsAt.getTime() - 1));
  if (end < event.startsAt) return 0;
  const last = localDateOf(end, timeZone);
  let best = 0;
  for (let date = first; date <= last; date = addDays(date, 1)) {
    best = Math.max(best, streakEndingOn(history, date));
  }
  return best;
}
