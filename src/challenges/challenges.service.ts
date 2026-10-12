import {
  ConflictException,
  Injectable,
  type OnModuleInit,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { Clock } from '../common/clock.js';
import type { LocalDate } from '../common/local-date.js';
import { localDateFromDb } from '../consistency/db.js';
import { UserTodayService } from '../consistency/user-today.service.js';
import type { Challenge, Prisma } from '../generated/prisma/client.js';
import { JobsService } from '../jobs/jobs.service.js';
import { nameOf } from '../notifications/notification-copy.js';
import { notificationLinks } from '../notifications/notification-links.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import {
  challengePhase,
  challengeReached,
  participantValue,
  windowEnd,
  type ChallengeTemplate,
  type DayFocus,
} from './challenge-rules.js';
import type { ChallengeDto, ChallengeListsDto, PersonDto } from './challenges.dto.js';

type Tx = Prisma.TransactionClient;
const FINISHED_SHOWN = 20;
const DAY_MS = 86_400_000;
/** Sessions submit it (A6.3): a session may have completed a challenge nobody is looking at. */
export const EVALUATE_JOB = 'challenges.evaluate';

/**
 * A5.5 Challenges (spec §15, docs/02, docs/06 Challenge). A challenge copies its template's terms
 * at creation and runs on a window of local dates from the creator's today. Each participant's
 * progress is derived from their own counted sessions on those dates; nothing is counted here.
 * Inviting needs a friendship (a mutual follow) and no block. Declining or leaving removes the
 * place, without a trace or a penalty; a challenge not reached simply ends.
 */
@Injectable()
export class ChallengesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly userToday: UserTodayService,
    private readonly clock: Clock,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register(EVALUATE_JOB, (payload) =>
      this.evaluateFor((payload as { userId: string }).userId),
    );
    // An invitation is worth sending while it stands and the challenge has not finished.
    this.notifications.registerRelevance('friendInvite', async ({ userId, subject }) => {
      const place = await this.prisma.challengeParticipant.findUnique({
        where: { challengeId_userId: { challengeId: subject ?? '', userId } },
        include: { challenge: true },
      });
      if (place?.status !== 'invited') return false;
      const today = await this.userToday.today(userId);
      const phase = challengePhase(
        today,
        windowOf(place.challenge),
        place.challenge.completedAt !== null,
      );
      return phase === 'upcoming' || phase === 'active';
    });
  }

  /**
   * After a counted session (A6.3): settles the completion of the person's joined challenges
   * that are still running, so the others hear of it without opening the app.
   */
  async evaluateFor(userId: string): Promise<void> {
    const places = await this.prisma.challengeParticipant.findMany({
      where: { userId, status: 'joined', challenge: { completedAt: null } },
      include: { challenge: true },
    });
    if (places.length === 0) return;
    const today = await this.userToday.today(userId);
    for (const place of places) {
      const phase = challengePhase(today, windowOf(place.challenge), false);
      if (phase === 'active') await this.view(place.challenge, userId, today);
    }
  }

  async templates(): Promise<{ items: ChallengeTemplate[] }> {
    return { items: [...(await this.config.active()).get('challenge.templates')] };
  }

  async create(
    userId: string,
    templateId: string,
    invite: readonly string[],
  ): Promise<ChallengeDto> {
    const active = await this.config.active();
    const template = active.get('challenge.templates').find((t) => t.id === templateId);
    if (!template) throw unprocessable('unknown_template', 'There is no such challenge.');
    if (template.kind === 'personal' && invite.length > 0) {
      throw unprocessable('personal_challenge', 'A personal challenge is just for you.');
    }
    const today = await this.userToday.today(userId);
    const id = await this.prisma.$transaction(async (tx) => {
      const now = this.clock.now();
      const challenge = await tx.challenge.create({
        data: {
          templateId: template.id,
          kind: template.kind,
          measure: template.measure,
          goal: template.goal,
          target: template.target,
          dailyMinutes: template.dailyMinutes,
          days: template.days,
          maxParticipants: template.maxParticipants,
          configVersion: active.version,
          startDate: dbDate(today),
          endDate: dbDate(windowEnd(today, template.days)),
          createdById: userId,
          createdAt: now,
        },
      });
      await tx.challengeParticipant.create({
        data: {
          challengeId: challenge.id,
          userId,
          status: 'joined',
          createdAt: now,
          joinedAt: now,
        },
      });
      await this.addInvites(tx, challenge, userId, invite, now);
      return challenge.id;
    });
    return this.one(userId, id);
  }

  async invite(
    userId: string,
    challengeId: string,
    userIds: readonly string[],
  ): Promise<ChallengeDto> {
    const today = await this.userToday.today(userId);
    await this.prisma.$transaction(async (tx) => {
      const challenge = await lockChallenge(tx, challengeId);
      const place = challenge && (await placeOf(tx, challengeId, userId));
      if (!challenge || place?.status !== 'joined') throw challengeNotFound();
      if (challenge.kind === 'personal') {
        throw unprocessable('personal_challenge', 'A personal challenge is just for you.');
      }
      this.refuseFinished(challenge, today);
      await this.addInvites(tx, challenge, userId, userIds, this.clock.now());
    });
    return this.one(userId, challengeId);
  }

  async accept(userId: string, challengeId: string): Promise<ChallengeDto> {
    const today = await this.userToday.today(userId);
    await this.prisma.$transaction(async (tx) => {
      const challenge = await lockChallenge(tx, challengeId);
      const place = challenge && (await placeOf(tx, challengeId, userId));
      if (!challenge || !place) throw challengeNotFound();
      if (place.status === 'joined') return;
      this.refuseFinished(challenge, today);
      const now = this.clock.now();
      await tx.challengeParticipant.update({
        where: { challengeId_userId: { challengeId, userId } },
        data: { status: 'joined', joinedAt: now },
      });
      if (place.invitedById) {
        const joiner = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { displayName: true, username: true },
        });
        await this.notifications.enqueue(tx, {
          userId: place.invitedById,
          category: 'challengeUpdate',
          dedupeKey: `challenge-joined:${challengeId}:${userId}`,
          subject: challengeId,
          copy: { category: 'challengeUpdate', kind: 'joined', friendName: nameOf(joiner) },
          link: notificationLinks.challenge(challengeId),
          requested: false,
          notBefore: now,
          expiresAt: endOf(challenge),
        });
      }
    });
    return this.one(userId, challengeId);
  }

  async decline(userId: string, challengeId: string): Promise<void> {
    const removed = await this.prisma.challengeParticipant.deleteMany({
      where: { challengeId, userId, status: 'invited' },
    });
    if (removed.count === 0) throw challengeNotFound();
  }

  async leave(userId: string, challengeId: string): Promise<void> {
    const removed = await this.prisma.challengeParticipant.deleteMany({
      where: { challengeId, userId, status: 'joined' },
    });
    if (removed.count === 0) throw challengeNotFound();
  }

  async one(userId: string, challengeId: string): Promise<ChallengeDto> {
    const place = await placeOf(this.prisma, challengeId, userId);
    if (!place) throw challengeNotFound();
    const challenge = await this.prisma.challenge.findUniqueOrThrow({ where: { id: challengeId } });
    return this.view(challenge, userId, await this.userToday.today(userId));
  }

  /** The viewer's current challenges, invitations, and the latest finished ones. */
  async lists(userId: string): Promise<ChallengeListsDto> {
    const today = await this.userToday.today(userId);
    const places = await this.prisma.challengeParticipant.findMany({
      where: { userId },
      include: { challenge: true },
      orderBy: [{ challenge: { createdAt: 'desc' } }, { challengeId: 'desc' }],
    });
    const lists: ChallengeListsDto = { current: [], invitations: [], finished: [] };
    for (const place of places) {
      const dto = await this.view(place.challenge, userId, today);
      if (place.status === 'invited') {
        if (dto.phase === 'upcoming' || dto.phase === 'active') lists.invitations.push(dto);
      } else if (dto.phase === 'upcoming' || dto.phase === 'active') {
        lists.current.push(dto);
      } else if (lists.finished.length < FINISHED_SHOWN) {
        lists.finished.push(dto);
      }
    }
    return lists;
  }

  private refuseFinished(challenge: Challenge, today: LocalDate): void {
    const window = {
      startDate: localDateFromDb(challenge.startDate),
      endDate: localDateFromDb(challenge.endDate),
    };
    const phase = challengePhase(today, window, challenge.completedAt !== null);
    if (phase === 'ended' || phase === 'completed') {
      throw conflict('challenge_finished', 'This challenge has finished.');
    }
  }

  /** Invites friends of the inviter: mutual follows, active, with no block either way. */
  private async addInvites(
    tx: Tx,
    challenge: Challenge,
    inviterId: string,
    userIds: readonly string[],
    now: Date,
  ): Promise<void> {
    const ids = [...new Set(userIds)].filter((id) => id !== inviterId);
    if (ids.length === 0) return;
    const friends = await tx.$queryRaw<{ id: string }[]>`
      SELECT u.id FROM users u
      WHERE u.id = ANY(${ids}::uuid[]) AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM follows WHERE follower_id = ${inviterId}::uuid AND followee_id = u.id)
        AND EXISTS (SELECT 1 FROM follows WHERE follower_id = u.id AND followee_id = ${inviterId}::uuid)
        AND NOT EXISTS (
          SELECT 1 FROM blocks
          WHERE (blocker_id = ${inviterId}::uuid AND blocked_id = u.id)
             OR (blocker_id = u.id AND blocked_id = ${inviterId}::uuid))`;
    if (friends.length !== ids.length) {
      throw unprocessable('not_a_friend', 'You can invite only your friends.');
    }
    const existing = await tx.challengeParticipant.findMany({
      where: { challengeId: challenge.id },
      select: { userId: true },
    });
    const present = new Set(existing.map((p) => p.userId));
    const fresh = ids.filter((id) => !present.has(id));
    if (existing.length + fresh.length > challenge.maxParticipants) {
      throw conflict('challenge_full', 'This challenge has no room for everyone invited.');
    }
    await tx.challengeParticipant.createMany({
      data: fresh.map((userId) => ({
        challengeId: challenge.id,
        userId,
        status: 'invited' as const,
        invitedById: inviterId,
        createdAt: now,
      })),
      skipDuplicates: true,
    });
    if (fresh.length === 0) return;
    const inviter = await tx.user.findUniqueOrThrow({
      where: { id: inviterId },
      select: { displayName: true, username: true },
    });
    for (const userId of fresh) {
      await this.notifications.enqueue(tx, {
        userId,
        category: 'friendInvite',
        dedupeKey: `challenge-invite:${challenge.id}`,
        subject: challenge.id,
        copy: { category: 'friendInvite', friendName: nameOf(inviter) },
        link: notificationLinks.challenge(challenge.id),
        requested: false,
        notBefore: now,
        expiresAt: endOf(challenge),
      });
    }
  }

  private async view(
    challenge: Challenge,
    viewerId: string,
    today: LocalDate,
  ): Promise<ChallengeDto> {
    const window = {
      startDate: localDateFromDb(challenge.startDate),
      endDate: localDateFromDb(challenge.endDate),
    };
    const places = await this.prisma.challengeParticipant.findMany({
      where: { challengeId: challenge.id },
      include: {
        user: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, status: true },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
    });
    const joined = places.filter((p) => p.status === 'joined');
    const focus = await this.focusByUser(
      joined.map((p) => p.userId),
      window,
    );
    const valueOf = (userId: string) => participantValue(challenge, focus.get(userId) ?? []);
    const values = joined.map((p) => valueOf(p.userId));
    let completedAt = challenge.completedAt;
    if (!completedAt && challengeReached(challenge.goal, challenge.target, values)) {
      completedAt = this.clock.now();
      // Stored once, the first time it is seen reached; never moved or removed afterwards. Who
      // stores it tells the others (A6.3); the viewer sees it right here.
      const now = completedAt;
      await this.prisma.$transaction(async (tx) => {
        const stored = await tx.challenge.updateMany({
          where: { id: challenge.id, completedAt: null },
          data: { completedAt: now },
        });
        if (stored.count === 0) return;
        for (const p of joined.filter((place) => place.userId !== viewerId)) {
          await this.notifications.enqueue(tx, {
            userId: p.userId,
            category: 'challengeUpdate',
            dedupeKey: `challenge-completed:${challenge.id}`,
            subject: challenge.id,
            copy: { category: 'challengeUpdate', kind: 'completed' },
            link: notificationLinks.challenge(challenge.id),
            requested: false,
            notBefore: now,
            expiresAt: new Date(now.getTime() + 3 * DAY_MS),
          });
        }
      });
      completedAt =
        (await this.prisma.challenge.findUniqueOrThrow({ where: { id: challenge.id } }))
          .completedAt ?? completedAt;
    }
    const hidden = await this.blockedWith(
      viewerId,
      places.map((p) => p.userId),
    );
    const shown = (p: (typeof places)[number]) =>
      p.userId === viewerId || (!hidden.has(p.userId) && p.user.status === 'active');
    const mine = places.find((p) => p.userId === viewerId)!;
    return {
      id: challenge.id,
      template: {
        id: challenge.templateId,
        kind: challenge.kind,
        measure: challenge.measure,
        goal: challenge.goal,
        target: challenge.target,
        dailyMinutes: challenge.dailyMinutes,
        days: challenge.days,
      },
      startDate: window.startDate,
      endDate: window.endDate,
      phase: challengePhase(today, window, completedAt !== null),
      completedAt: completedAt?.toISOString() ?? null,
      progress: {
        value:
          challenge.goal === 'shared'
            ? values.reduce((sum, value) => sum + value, 0)
            : mine.status === 'joined'
              ? valueOf(viewerId)
              : 0,
        target: challenge.target,
      },
      participants: joined.filter(shown).map((p) => {
        const value = valueOf(p.userId);
        return { user: person(p.user), value, reached: value >= challenge.target };
      }),
      invited: places.filter((p) => p.status === 'invited' && shown(p)).map((p) => person(p.user)),
      you: { status: mine.status },
    };
  }

  /** Each participant's counted focus per local date in the window, in one statement. */
  private async focusByUser(
    userIds: readonly string[],
    window: { startDate: LocalDate; endDate: LocalDate },
  ): Promise<Map<string, DayFocus[]>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<
      { user_id: string; local_date: Date; milliseconds: bigint; sessions: bigint }[]
    >`
      SELECT user_id, local_date, SUM(focused_milliseconds)::bigint AS milliseconds,
             COUNT(*) AS sessions
      FROM focus_sessions
      WHERE user_id = ANY(${[...userIds]}::uuid[]) AND status <> 'discarded'
        AND local_date BETWEEN ${window.startDate}::date AND ${window.endDate}::date
      GROUP BY user_id, local_date`;
    const byUser = new Map<string, DayFocus[]>();
    for (const row of rows) {
      const days = byUser.get(row.user_id) ?? [];
      days.push({
        date: localDateFromDb(row.local_date),
        minutes: Math.floor(Number(row.milliseconds) / 60_000),
        sessions: Number(row.sessions),
      });
      byUser.set(row.user_id, days);
    }
    return byUser;
  }

  private async blockedWith(viewerId: string, userIds: readonly string[]): Promise<Set<string>> {
    const rows = await this.prisma.block.findMany({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: { in: [...userIds] } },
          { blockedId: viewerId, blockerId: { in: [...userIds] } },
        ],
      },
      select: { blockerId: true, blockedId: true },
    });
    return new Set(rows.map((row) => (row.blockerId === viewerId ? row.blockedId : row.blockerId)));
  }
}

function person(user: {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}): PersonDto {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}

function dbDate(date: LocalDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

async function lockChallenge(tx: Tx, challengeId: string): Promise<Challenge | null> {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM challenges WHERE id = ${challengeId}::uuid FOR UPDATE`;
  return row ? tx.challenge.findUnique({ where: { id: challengeId } }) : null;
}

function placeOf(client: Tx | PrismaService, challengeId: string, userId: string) {
  return client.challengeParticipant.findUnique({
    where: { challengeId_userId: { challengeId, userId } },
  });
}

function unprocessable(code: string, message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message,
    code,
  });
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, error: 'Conflict', message, code });
}

function challengeNotFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    message: 'This challenge does not exist.',
    code: 'challenge_not_found',
  });
}

function windowOf(challenge: Challenge): { startDate: LocalDate; endDate: LocalDate } {
  return {
    startDate: localDateFromDb(challenge.startDate),
    endDate: localDateFromDb(challenge.endDate),
  };
}

/** A day after the challenge's last date: past it in every time zone. */
function endOf(challenge: Challenge): Date {
  return new Date(challenge.endDate.getTime() + 2 * DAY_MS);
}
