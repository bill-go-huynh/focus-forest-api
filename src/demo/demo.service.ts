import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'node:crypto';

import { AdminAuditService } from '../admin/admin-audit.service.js';
import { ChallengesService } from '../challenges/challenges.service.js';
import { Clock } from '../common/clock.js';
import { lockUser } from '../consistency/db.js';
import { LiveService } from '../content/live.service.js';
import { EventsService } from '../events/events.service.js';
import { PasswordHasher } from '../identity/password-hasher.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { NotificationCopyInput } from '../notifications/notification-copy.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { AchievementsService } from '../progression/achievements.service.js';
import { RoomsService } from '../rooms/rooms.service.js';
import { MonthAttributionService } from '../sessions/attribution/month-attribution.service.js';
import { ReactionsService } from '../social/reactions.service.js';
import { SocialGraphService } from '../social/social-graph.service.js';
import { MonthClosureService } from '../trees/month-closure.service.js';
import { DemoTooEarlyError, worldPlan, type PlannedSession } from './demo-plan.js';

/**
 * DM.1 Demo tools (spec/demo/PLAN.md). Not product scope: a local demo and QA tool, on only with
 * DEMO_TOOLS=on outside production (env validation), for the admin role, every action audited.
 *
 * The server keeps one real clock and much of the product is one-shot (archived trees, the
 * ceremony, ownership, Community Tree totals), so nothing is ever rewound: each demo makes a
 * fresh world, with history written the way the product writes it (sessions under the user's
 * lock, month contexts from the attribution service, past months closed by the closure service),
 * poised so one real session on the phone shows the moment.
 *
 * Services other modules do not export (rooms, challenges, social graph, live content) are
 * resolved from the app, so the demo adds no exports to the product's modules.
 */

/** The presenter's time zone: Vietnam, UTC+7 all year. */
export const DEMO_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const OFFSET_HOURS = 7;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const DOMAIN = 'focusforest.test';
const EMAIL = /^demo(\d+)(?:-([a-z-]+))?@focusforest\.test$/;

export const DEMO_PERSONAS = [
  'main',
  'comeback',
  'recovery',
  'friend-mai',
  'friend-khoa',
  'friend-linh',
] as const;
export type DemoPersona = (typeof DEMO_PERSONAS)[number];

const PROFILES: Record<DemoPersona, { name: string; username: string }> = {
  main: { name: 'Bill', username: 'bill' },
  comeback: { name: 'An', username: 'an' },
  recovery: { name: 'Vy', username: 'vy' },
  'friend-mai': { name: 'Mai', username: 'mai' },
  'friend-khoa': { name: 'Khoa', username: 'khoa' },
  'friend-linh': { name: 'Linh', username: 'linh' },
};

export const DEMO_CATEGORIES = [
  'dailyGoalReminder',
  'scheduledFocusReminder',
  'streakReminder',
  'eventStart',
  'eventEndingSoon',
  'friendInvite',
  'focusRoomInvite',
  'challengeUpdate',
  'badgeUnlocked',
  'monthlyRecapReady',
] as const;
export type DemoCategory = (typeof DEMO_CATEGORIES)[number];

export interface DemoAccount {
  persona: DemoPersona;
  email: string;
  userId: string;
  name: string;
}
export interface DemoWorld {
  id: number;
  eventId: string;
  accounts: DemoAccount[];
}
export interface DemoNotifyResult {
  category: DemoCategory;
  status: 'sent' | 'skipped' | 'failed' | 'pending';
  reason: string | null;
  title: string | null;
}

const emailOf = (world: number, persona: DemoPersona) =>
  persona === 'main' ? `demo${world}@${DOMAIN}` : `demo${world}-${persona}@${DOMAIN}`;
const eventIdOf = (world: number) => `demo-world-${world}`;

/** A local date and time in the demo time zone, as an instant. */
function instant(localDate: string, hour: number, minute: number): Date {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour - OFFSET_HOURS, minute));
}
const localToday = (now: Date) =>
  new Date(now.getTime() + OFFSET_HOURS * 60 * MIN).toISOString().slice(0, 10);
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

@Injectable()
export class DemoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly passwords: PasswordHasher,
    private readonly attribution: MonthAttributionService,
    private readonly closure: MonthClosureService,
    private readonly achievements: AchievementsService,
    private readonly reactions: ReactionsService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    private readonly config: ProductConfigService,
    private readonly audit: AdminAuditService,
    private readonly modules: ModuleRef,
  ) {}

  private get rooms() {
    return this.modules.get(RoomsService, { strict: false });
  }
  private get challenges() {
    return this.modules.get(ChallengesService, { strict: false });
  }
  private get graph() {
    return this.modules.get(SocialGraphService, { strict: false });
  }
  private get live() {
    return this.modules.get(LiveService, { strict: false });
  }

  /** Every demo world, from its accounts' addresses. */
  async worlds(): Promise<{ items: DemoWorld[] }> {
    const users = await this.prisma.user.findMany({
      where: { email: { endsWith: `@${DOMAIN}`, startsWith: 'demo' } },
      select: { id: true, email: true, displayName: true },
    });
    const byWorld = new Map<number, DemoAccount[]>();
    for (const user of users) {
      const match = EMAIL.exec(user.email);
      if (!match) continue;
      const persona = (match[2] ?? 'main') as DemoPersona;
      if (!DEMO_PERSONAS.includes(persona)) continue;
      const world = Number(match[1]);
      const list = byWorld.get(world) ?? [];
      list.push({ persona, email: user.email, userId: user.id, name: user.displayName ?? '' });
      byWorld.set(world, list);
    }
    const items = [...byWorld.entries()]
      .sort(([a], [b]) => b - a)
      .map(([id, accounts]) => ({
        id,
        eventId: eventIdOf(id),
        accounts: DEMO_PERSONAS.flatMap((p) => accounts.filter((a) => a.persona === p)),
      }));
    return { items };
  }

  async createWorld(adminId: string, password: string, reason: string): Promise<DemoWorld> {
    const now = this.clock.now();
    const today = localToday(now);
    let plan;
    try {
      plan = worldPlan(today);
    } catch (error) {
      if (error instanceof DemoTooEarlyError) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: error.message,
          code: 'demo_too_early',
        });
      }
      throw error;
    }
    const existing = (await this.worlds()).items.map((w) => w.id);
    const world = Math.max(0, ...existing) + 1;
    const passwordHash = await this.passwords.hash(password);
    const configVersion = (await this.config.active()).version;
    const joined = new Date(`${addDays(today, -110).slice(0, 8)}01T00:00:00Z`);

    const accounts: DemoAccount[] = [];
    for (const persona of DEMO_PERSONAS) {
      const profile = PROFILES[persona];
      const user = await this.prisma.user.create({
        data: {
          email: emailOf(world, persona),
          passwordHash,
          displayName: profile.name,
          username: `demo${world}_${profile.username}`,
          timezone: DEMO_TIME_ZONE,
          createdAt: joined,
        },
      });
      accounts.push({ persona, email: user.email, userId: user.id, name: profile.name });
    }
    const id = (persona: DemoPersona) => accounts.find((a) => a.persona === persona)!.userId;

    // History: the main account leaves last month open (the planting ceremony on first open);
    // the others have every past month closed.
    const histories: [DemoPersona, PlannedSession[]][] = [
      ['main', plan.main],
      ['comeback', plan.comeback],
      ['recovery', plan.recovery],
      ['friend-mai', plan.friends[0]],
      ['friend-khoa', plan.friends[1]],
      ['friend-linh', plan.friends[2]],
    ];
    const lastMonth = addDays(`${today.slice(0, 8)}01`, -1).slice(0, 7);
    for (const [persona, sessions] of histories) {
      await this.seedUser(id(persona), sessions, {
        today,
        configVersion,
        leaveOpen: persona === 'main' ? lastMonth : null,
        firstGoalFrom: joined,
      });
      // Badges already earned arrive quietly, as they would have.
      await this.achievements.reconcile(id(persona));
    }

    // Friends: mutual follows, on the leaderboard, a few reactions on the presenter's forest.
    const friends: DemoPersona[] = ['friend-mai', 'friend-khoa', 'friend-linh'];
    for (const friend of friends) {
      await this.graph.follow(id('main'), id(friend));
      await this.graph.follow(id(friend), id('main'));
    }
    const kinds = ['fire', 'sprout', 'heart'] as const;
    for (const [i, friend] of friends.entries()) {
      await this.reactions.add(id(friend), id('main'), { type: 'forest', key: '' }, kinds[i]!);
    }

    // The event and its Community Tree: the first milestone sits 15 minutes past what the
    // participants' sessions in its window add up to, so one session crosses it.
    const eventStart = instant(addDays(today, -1), 0, 0);
    const backfill = histories
      .filter(([persona]) => persona === 'main' || friends.includes(persona))
      .flatMap(([, sessions]) => sessions)
      .filter((s) => instant(s.localDate, s.startHour, s.startMinute) >= eventStart)
      .reduce((total, s) => total + s.minutes, 0);
    await this.createEvent(adminId, world, eventStart, backfill + 15);
    for (const participant of [...friends, 'main' as const]) {
      await this.events.join(id(participant), eventIdOf(world));
    }

    await this.audit.record({
      adminId,
      action: 'demo.world.create',
      targetType: 'demo_world',
      targetId: String(world),
      reason,
    });
    return { id: world, eventId: eventIdOf(world), accounts };
  }

  /**
   * Writes a persona's sessions month by month under its lock, closing each past month (except
   * `leaveOpen`) as the product would have, and marking its ceremony and recap seen.
   */
  private async seedUser(
    userId: string,
    sessions: readonly PlannedSession[],
    options: {
      today: string;
      configVersion: number;
      leaveOpen: string | null;
      firstGoalFrom: Date;
    },
  ): Promise<void> {
    const topics = await this.createTopics(userId);
    await this.prisma.dailyGoalSetting.create({
      data: { userId, effectiveFrom: options.firstGoalFrom, minutes: 30 },
    });
    await this.prisma.privacySettings.create({
      data: {
        userId,
        profile: 'friends',
        forest: 'friends',
        statistics: 'private',
        badges: 'friends',
        currentTree: 'friends',
        leaderboards: true,
      },
    });
    const months = [...new Set(sessions.map((s) => s.localDate.slice(0, 7)))].sort();
    const current = options.today.slice(0, 7);
    for (const month of months) {
      await this.prisma.$transaction(
        async (tx) => {
          await lockUser(tx, userId);
          for (const [i, s] of sessions.filter((x) => x.localDate.startsWith(month)).entries()) {
            const startedAt = instant(s.localDate, s.startHour, s.startMinute);
            const endedAt = new Date(startedAt.getTime() + s.minutes * MIN);
            const at = await this.attribution.attribute(userId, startedAt, tx);
            await tx.focusSession.create({
              data: {
                id: randomUUID(),
                userId,
                topicId: topics[i % topics.length]!,
                startedAt,
                submittedEndedAt: endedAt,
                plannedMinutes: s.minutes,
                pauseIntervals: [],
                effectiveEndedAt: endedAt,
                focusedMilliseconds: s.minutes * MIN,
                pausedMilliseconds: 0,
                status: 'completed',
                localDate: new Date(`${at.localDate}T00:00:00.000Z`),
                year: at.year,
                month: at.month,
                configVersion: options.configVersion,
                createdAt: endedAt,
              },
            });
          }
          if (month !== current && month !== options.leaveOpen) {
            await this.closure.closeEndedMonthsIn(tx, userId);
            const [year, monthNumber] = month.split('-').map(Number) as [number, number];
            const now = this.clock.now();
            await tx.monthlyRecap.updateMany({
              where: { userId, year, month: monthNumber, ceremonySeenAt: null },
              data: { ceremonySeenAt: now, recapSeenAt: now },
            });
          }
        },
        { timeout: 60_000 },
      );
    }
  }

  private async createTopics(userId: string): Promise<string[]> {
    const topics = [
      { name: 'Reading', icon: 'book', color: 'topic.3' },
      { name: 'Code', icon: 'code', color: 'topic.10' },
      { name: 'Writing', icon: 'pen', color: 'topic.4' },
    ];
    const ids: string[] = [];
    for (const topic of topics) {
      const id = randomUUID();
      await this.prisma.topic.create({
        data: { id, userId, ...topic, createFingerprint: `demo:${id}` },
      });
      ids.push(id);
    }
    return ids;
  }

  private async createEvent(
    adminId: string,
    world: number,
    startsAt: Date,
    firstMilestone: number,
  ) {
    const id = eventIdOf(world);
    const endsAt = new Date(startsAt.getTime() + 15 * DAY);
    const stages = ['seedling', 'growing_tree', 'bloom', 'final_form'] as const;
    for (const stage of stages) {
      await this.prisma.badgeDefinition.create({
        data: {
          id: `${id}:${stage.replace('_', '-')}`,
          category: 'event',
          rarity: 'common',
          source: 'event',
          availability: 'limited',
          status: 'active',
          availableFrom: startsAt,
          availableUntil: new Date(endsAt.getTime() + 7 * DAY),
          name: `Demo Grove ${stage.replace('_', ' ')}`,
          description: 'Grew the demo Community Tree together.',
          artworkId: `${id}-${stage.replace('_', '-')}`,
        },
      });
    }
    await this.live.createEvent(adminId, {
      id,
      name: `Demo Grove ${world}`,
      description: 'A demo event: everyone’s focus grows one shared tree.',
      artworkId: 'demo-grove',
      status: 'active',
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      entryMinSessions: 0,
      leaderboard: false,
      teams: [],
      missions: [
        {
          id: 'two-hours',
          measure: 'focus_minutes',
          target: 120,
          dailyMinutes: 0,
          name: 'Focus 2 hours',
          description: 'Two hours of focus during the event.',
        },
      ],
      milestones: [],
      communityTree: {
        name: 'The Demo Grove',
        artworkId: 'demo-grove',
        milestones: stages.map((stage, i) => ({
          stage,
          thresholdMinutes: firstMilestone + i * 300,
          badgeId: `${id}:${stage.replace('_', '-')}`,
        })),
      },
      reason: `Demo world ${world}`,
    });
  }

  private async worldOrThrow(world: number): Promise<DemoWorld> {
    const found = (await this.worlds()).items.find((w) => w.id === world);
    if (!found) throw new NotFoundException('There is no such demo world.');
    return found;
  }
  private static user(world: DemoWorld, persona: DemoPersona): string {
    const account = world.accounts.find((a) => a.persona === persona);
    if (!account) throw new BadRequestException(`This world has no ${persona} account.`);
    return account.userId;
  }

  /**
   * Sends a notification of `category` to a persona at once: the category turned on, then the
   * real pipeline (requested, so quiet hours and the daily limit don't hold it). Invitations and
   * challenge updates go through their real flows. Answers what became of it.
   */
  async notify(
    adminId: string,
    worldId: number,
    persona: DemoPersona,
    category: DemoCategory,
  ): Promise<DemoNotifyResult> {
    const world = await this.worldOrThrow(worldId);
    const userId = DemoService.user(world, persona);
    const now = this.clock.now();
    const since = new Date(now.getTime() - 1000);
    const result = (
      status: DemoNotifyResult['status'],
      reason: string | null,
      title: string | null,
    ) => ({ category, status, reason, title }) satisfies DemoNotifyResult;

    if ((await this.prisma.pushDevice.count({ where: { userId } })) === 0) {
      return result('skipped', 'no_device', null);
    }
    const time = this.quarterNow(now);
    await this.prisma.notificationPreference.upsert({
      where: { userId_category: { userId, category } },
      create: { userId, category, enabled: true, time: isReminder(category) ? time : null },
      update: { enabled: true, ...(isReminder(category) ? { time } : {}) },
    });

    if (category === 'friendInvite') {
      await this.challenges.create(DemoService.user(world, 'friend-mai'), 'steady-week-together', [
        userId,
      ]);
    } else if (category === 'focusRoomInvite') {
      const mai = DemoService.user(world, 'friend-mai');
      await this.leaveRoom(mai);
      const room = await this.rooms.create(mai, {
        name: 'Study with Mai',
        topic: null,
        durationMinutes: 25,
        maxParticipants: 4,
        visibility: 'private',
      });
      await this.rooms.invite(mai, room.id, [userId]);
    } else if (category === 'challengeUpdate') {
      const khoa = DemoService.user(world, 'friend-khoa');
      const challenge = await this.challenges.create(userId, 'steady-week-together', [khoa]);
      await this.challenges.accept(khoa, challenge.id);
    } else {
      await this.notifications.enqueue(this.prisma, {
        userId,
        category,
        dedupeKey: `demo:${randomUUID()}`,
        subject: this.subject(category, world, now, time),
        copy: this.copy(category, world, now),
        link: this.link(category, world, now),
        requested: true,
        notBefore: now,
        expiresAt: new Date(now.getTime() + 60 * MIN),
      });
    }
    // What a real flow enqueued waits for the day's window: send it now.
    await this.prisma.notificationOutbox.updateMany({
      where: {
        userId,
        category: category,
        status: 'pending',
        createdAt: { gte: since },
      },
      data: { requested: true, notBefore: now },
    });
    await this.notifications.dispatchDue(now);
    const row = await this.prisma.notificationOutbox.findFirst({
      where: { userId, category: category, createdAt: { gte: since } },
      orderBy: { id: 'desc' },
    });
    await this.audit.record({
      adminId,
      action: 'demo.notify',
      targetType: 'user',
      targetId: userId,
      reason: `Demo world ${worldId}: ${category}`,
    });
    if (!row) return result('skipped', 'not_created', null);
    return result(row.status, row.reason, row.title);
  }

  /** A friend joins the presenter's lobby and is ready: the room counts down and starts. */
  async friendReady(adminId: string, worldId: number): Promise<unknown> {
    const world = await this.worldOrThrow(worldId);
    const main = DemoService.user(world, 'main');
    const khoa = DemoService.user(world, 'friend-khoa');
    const { room } = await this.rooms.current(main);
    if (!room || !room.code) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Open a room in Focus Together on the phone first.',
        code: 'no_lobby',
      });
    }
    await this.leaveRoom(khoa);
    await this.rooms.joinByCode(khoa, room.code);
    const ready = await this.rooms.ready(khoa, room.id, true);
    await this.audit.record({
      adminId,
      action: 'demo.friend_ready',
      targetType: 'room',
      targetId: room.id,
      reason: `Demo world ${worldId}`,
    });
    return ready;
  }

  private async leaveRoom(userId: string): Promise<void> {
    const { room } = await this.rooms.current(userId);
    if (room) await this.rooms.leave(userId, room.id).catch(() => undefined);
  }

  private quarterNow(now: Date): string {
    const local = new Date(now.getTime() + OFFSET_HOURS * 60 * MIN);
    const minutes = Math.floor(local.getUTCMinutes() / 15) * 15;
    return `${String(local.getUTCHours()).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  private subject(
    category: DemoCategory,
    world: DemoWorld,
    now: Date,
    time: string,
  ): string | null {
    if (isReminder(category)) return `${localToday(now)} ${time}`;
    if (category === 'eventStart' || category === 'eventEndingSoon') return world.eventId;
    return null;
  }

  private copy(category: DemoCategory, world: DemoWorld, now: Date): NotificationCopyInput {
    switch (category) {
      case 'dailyGoalReminder':
        return { category, goalMinutes: 30 };
      case 'scheduledFocusReminder':
        return { category };
      case 'streakReminder':
        return { category, streakDays: 6 };
      case 'eventStart':
      case 'eventEndingSoon':
        return { category, eventName: `Demo Grove ${world.id}` };
      case 'badgeUnlocked':
        return { category, badgeName: 'Community Contributor' };
      case 'monthlyRecapReady': {
        const last = lastMonth(now);
        return { category, year: last.year, month: last.month };
      }
      default:
        throw new BadRequestException(`${category} goes through its own flow.`);
    }
  }

  private link(category: DemoCategory, world: DemoWorld, now: Date): string {
    if (category === 'eventStart' || category === 'eventEndingSoon') {
      return `/together/events/${world.eventId}`;
    }
    if (category === 'badgeUnlocked') return '/profile/achievements';
    if (category === 'monthlyRecapReady') {
      const last = lastMonth(now);
      return `/recap/${last.year}/${last.month}`;
    }
    return '/';
  }
}

const isReminder = (category: DemoCategory) =>
  category === 'dailyGoalReminder' ||
  category === 'scheduledFocusReminder' ||
  category === 'streakReminder';

function lastMonth(now: Date): { year: number; month: number } {
  const today = localToday(now);
  const [y, m] = today.split('-').map(Number) as [number, number];
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}
