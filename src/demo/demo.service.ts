import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { randomUUID } from 'node:crypto';

import { AdminAuditService } from '../admin/admin-audit.service.js';
import { ChallengesService } from '../challenges/challenges.service.js';
import { MonthlyTreesService } from '../trees/monthly-trees.service.js';
import { PushTransport, type PushReceipt } from '../notifications/push-transport.js';
import { Clock } from '../common/clock.js';
import { lockUser } from '../consistency/db.js';
import { PasswordHasher } from '../identity/password-hasher.js';
import { NotificationsService, PUSH_RECEIPTS_JOB } from '../notifications/notifications.service.js';
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
import { DemoEvents } from './demo-live.gateway.js';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { RestDaysService } from '../consistency/rest-days.service.js';
import { SessionsService } from '../sessions/sessions.service.js';

/**
 * DM.1 Demo tools (spec/demo/PLAN.md). Not product scope: a demo and QA tool, on only with
 * DEMO_TOOLS=on (meant for a demo server), for the admin role, every action audited.
 *
 * The server keeps one real clock and much of the product is one-shot (archived trees, the
 * ceremony, ownership), so nothing is ever rewound: each demo makes a
 * fresh world, with history written the way the product writes it (sessions under the user's
 * lock, month contexts from the attribution service, past months closed by the closure service),
 * poised so one real session on the phone shows the moment.
 *
 * Services other modules do not export (rooms, challenges, social graph, sessions) are
 * resolved from the app, so the demo adds no exports to the product's modules.
 */

/** The presenter's time zone: Vietnam, UTC+7 all year. */
export const DEMO_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const OFFSET_HOURS = 7;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const DOMAIN = 'focusforest.test';

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
  /** An email the admin entered signs in with Google; a demo address with the shared password. */
  signIn: 'google' | 'password';
  /** The shared password, for a demo address; null for Google. */
  password: string | null;
  /** Owner, 2026-10-23: is the account ready to show? Its phones and this month's tree. */
  devices: number;
  /** This month's tree stage, or null before it exists. */
  stage: string | null;
}

/**
 * The one password of every demo address (owner, 2026-10-22: no password step). Demo tools are
 * for a demo server only; an entered email gets no password and signs in with Google.
 */
export const DEMO_PASSWORD = 'focus-forest-demo';
const signInOf = (hasPassword: boolean): Pick<DemoAccount, 'signIn' | 'password'> =>
  hasPassword
    ? { signIn: 'password', password: DEMO_PASSWORD }
    : { signIn: 'google', password: null };
export interface DemoWorld {
  id: number;
  accounts: DemoAccount[];
}
export interface DemoNotifyResult {
  category: DemoCategory;
  status: 'sent' | 'skipped' | 'failed' | 'pending';
  reason: string | null;
  title: string | null;
}

/** The address a persona gets when the admin enters none. */
const emailOf = (world: number, persona: DemoPersona) =>
  persona === 'main' ? `demo${world}@${DOMAIN}` : `demo${world}-${persona}@${DOMAIN}`;

/** A local date and time in the demo time zone, as an instant. */
function instant(localDate: string, hour: number, minute: number): Date {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour - OFFSET_HOURS, minute));
}
const localToday = (now: Date) =>
  new Date(now.getTime() + OFFSET_HOURS * 60 * MIN).toISOString().slice(0, 10);
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** How long Expo gets to know whether FCM took a push (none in tests: the fake knows at once). */
const RECEIPT_WAIT_MS = process.env['NODE_ENV'] === 'test' ? 0 : 5000;

@Injectable()
export class DemoService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly passwords: PasswordHasher,
    private readonly attribution: MonthAttributionService,
    private readonly closure: MonthClosureService,
    private readonly achievements: AchievementsService,
    private readonly reactions: ReactionsService,
    private readonly notifications: NotificationsService,
    private readonly config: ProductConfigService,
    private readonly audit: AdminAuditService,
    private readonly modules: ModuleRef,
    private readonly live: DemoEvents,
    private readonly env: ConfigService<EnvironmentVariables, true>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.get('DEMO_TOOLS', { infer: true }) === 'on') {
      new Logger('DemoTools').warn(
        'DEMO_TOOLS is on: admins can make demo accounts and send notifications. Use it only on a demo server.',
      );
    }
  }

  private get rooms() {
    return this.modules.get(RoomsService, { strict: false });
  }
  private get challenges() {
    return this.modules.get(ChallengesService, { strict: false });
  }
  private get graph() {
    return this.modules.get(SocialGraphService, { strict: false });
  }
  private get sessions() {
    return this.modules.get(SessionsService, { strict: false });
  }
  private get trees() {
    return this.modules.get(MonthlyTreesService, { strict: false });
  }
  private get restDays() {
    return this.modules.get(RestDaysService, { strict: false });
  }

  /** Every demo world, from the accounts demo worlds made (`demo_accounts`). */
  async worlds(): Promise<{ items: DemoWorld[] }> {
    const rows = await this.prisma.demoAccount.findMany({
      select: {
        world: true,
        persona: true,
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            passwordHash: true,
            _count: { select: { pushDevices: true } },
          },
        },
      },
    });
    // This month's tree of each account (demo time zone); none until the account opens it.
    const [year, month] = localToday(this.clock.now()).split('-').map(Number) as [number, number];
    const trees = await this.prisma.monthlyTree.findMany({
      where: { userId: { in: rows.map((row) => row.user.id) }, year, month },
      select: { userId: true, stage: true },
    });
    const stageOf = new Map(trees.map((tree) => [tree.userId, tree.stage as string]));
    const byWorld = new Map<number, DemoAccount[]>();
    for (const { world, persona, user } of rows) {
      if (!(DEMO_PERSONAS as readonly string[]).includes(persona)) continue;
      const list = byWorld.get(world) ?? [];
      list.push({
        persona: persona as DemoPersona,
        email: user.email,
        userId: user.id,
        name: user.displayName ?? '',
        ...signInOf(user.passwordHash !== null),
        devices: user._count.pushDevices,
        stage: stageOf.get(user.id) ?? null,
      });
      byWorld.set(world, list);
    }
    const items = [...byWorld.entries()]
      .sort(([a], [b]) => b - a)
      .map(([id, accounts]) => ({
        id,
        accounts: DEMO_PERSONAS.flatMap((p) => accounts.filter((a) => a.persona === p)),
      }));
    return { items };
  }

  /**
   * `emails` are the addresses the admin entered for some personas (the rest get
   * `demoN…@focusforest.test`). No password is asked for: a demo address gets the shared
   * `DEMO_PASSWORD`, an entered email none (its owner signs in with Google). A world only ever makes new accounts: an address that already has
   * one is refused, so a real account's history is never touched.
   */
  async createWorld(
    adminId: string,
    reason: string,
    emails: Partial<Record<DemoPersona, string>> = {},
  ): Promise<DemoWorld> {
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
    const latest = await this.prisma.demoAccount.aggregate({ _max: { world: true } });
    const world = (latest._max.world ?? 0) + 1;
    const addresses = await this.addresses(world, emails);
    const passwordHash = await this.passwords.hash(DEMO_PASSWORD);
    const configVersion = (await this.config.active()).version;
    const joined = new Date(`${addDays(today, -110).slice(0, 8)}01T00:00:00Z`);
    // Linh's forest starts earlier (owner, 2026-10-23): she joined with her first month.
    const firstLinhMonth = Object.keys(plan.linhSpecies).sort()[0]!;
    const linhJoined = new Date(`${firstLinhMonth}-01T00:00:00Z`);
    const joinedOf = (persona: DemoPersona) => (persona === 'friend-linh' ? linhJoined : joined);

    const accounts: DemoAccount[] = [];
    for (const persona of DEMO_PERSONAS) {
      const profile = PROFILES[persona];
      // An entered email signs in with Google (linked on its first sign-in), so no password.
      const entered = addresses[persona] !== emailOf(world, persona);
      const user = await this.prisma.user.create({
        data: {
          email: addresses[persona],
          passwordHash: entered ? null : passwordHash,
          displayName: profile.name,
          username: `demo${world}_${profile.username}`,
          timezone: DEMO_TIME_ZONE,
          createdAt: joinedOf(persona),
          demoAccount: { create: { world, persona } },
        },
      });
      accounts.push({
        persona,
        email: user.email,
        userId: user.id,
        name: profile.name,
        ...signInOf(!entered),
        devices: 0,
        stage: null,
      });
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
        firstGoalFrom: joinedOf(persona),
        species: persona === 'friend-linh' ? plan.linhSpecies : {},
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
    // The comeback and recovery accounts follow the presenter too: followers beyond friends.
    await this.graph.follow(id('comeback'), id('main'));
    await this.graph.follow(id('recovery'), id('main'));
    const kinds = ['fire', 'sprout', 'heart'] as const;
    for (const [i, friend] of friends.entries()) {
      await this.reactions.add(id(friend), id('main'), { type: 'forest', key: '' }, kinds[i]!);
    }

    // A waiting room Mai opened, the presenter invited, Khoa already ready (owner, 2026-10-22).
    // Owner, 2026-10-23: one friend invites, Linh, who is on the second phone in the demo.
    await this.waitingRoom(id('main'), id('friend-linh'));
    await this.challenges.create(id('friend-linh'), 'steady-week-together', [id('main')]);

    await this.audit.record({
      adminId,
      action: 'demo.world.create',
      targetType: 'demo_world',
      targetId: String(world),
      reason,
    });
    // As listed, with each account's phones and tree (seeded by now).
    return (await this.worlds()).items.find((w) => w.id === world) ?? { id: world, accounts };
  }

  /** Each persona's address: the one entered (trimmed, lowercased) or the generated one. */
  private async addresses(
    world: number,
    entered: Partial<Record<DemoPersona, string>>,
  ): Promise<Record<DemoPersona, string>> {
    const addresses = Object.fromEntries(
      DEMO_PERSONAS.map((p) => [p, entered[p]?.trim().toLowerCase() || emailOf(world, p)]),
    ) as Record<DemoPersona, string>;
    const all = Object.values(addresses);
    const repeated = all.find((email, i) => all.indexOf(email) !== i);
    if (repeated) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `${repeated} is entered for two accounts. Each account needs its own email.`,
        code: 'email_repeated',
        email: repeated,
      });
    }
    const taken = await this.prisma.user.findFirst({
      where: { email: { in: all } },
      select: { email: true },
    });
    if (taken) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `${taken.email} already has an account. A demo world only makes new accounts.`,
        code: 'email_taken',
        email: taken.email,
      });
    }
    return addresses;
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
      /** A species per month ("YYYY-MM"), set before the month closes. */
      species: Record<string, string>;
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
          const species = options.species[month];
          if (species) {
            const [y, m] = month.split('-').map(Number) as [number, number];
            await this.trees.ensureTree(tx, userId, { year: y, month: m });
            await tx.monthlyTree.update({
              where: { userId_year_month: { userId, year: y, month: m } },
              data: { species },
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
      await this.challenges.create(DemoService.user(world, 'friend-linh'), 'steady-week-together', [
        userId,
      ]);
    } else if (category === 'focusRoomInvite') {
      await this.waitingRoom(userId, DemoService.user(world, 'friend-linh'));
    } else if (category === 'challengeUpdate') {
      const khoa = DemoService.user(world, 'friend-khoa');
      const challenge = await this.challenges.create(userId, 'steady-week-together', [khoa]);
      await this.challenges.accept(khoa, challenge.id);
    } else {
      await this.notifications.enqueue(this.prisma, {
        userId,
        category,
        dedupeKey: `demo:${randomUUID()}`,
        subject: this.subject(category, now, time),
        copy: this.copy(category, now),
        link: this.link(category, now),
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
    this.live.announce(userId, { type: 'refresh', reason: 'notification' });
    if (!row) return result('skipped', 'not_created', null);
    if (row.status === 'sent') {
      // Expo's receipt says whether FCM took it: "Sent" alone hid a push that never arrived
      // (owner, 2026-10-23). A few seconds for Expo to know, then the first error is said.
      const undelivered = await this.receiptError(since);
      if (undelivered) return result('failed', undelivered, row.title);
    }
    return result(row.status, row.reason, row.title);
  }

  /**
   * Linh opens a private waiting room and invites the presenter; she waits in it, so on the second
   * phone she sees the presenter join and both get ready for real. Any room she was in is left
   * first, so a lobby that ran out (2 h) is simply replaced.
   */
  private async waitingRoom(main: string, linh: string): Promise<void> {
    await this.leaveRoom(linh);
    const room = await this.rooms.create(linh, {
      name: 'Study with Linh',
      topic: null,
      durationMinutes: 25,
      maxParticipants: 4,
      visibility: 'private',
    });
    await this.rooms.invite(linh, room.id, [main]);
  }

  /**
   * Deletes a whole demo world (owner, 2026-10-23): its six accounts and, with them, everything
   * they made (sessions, trees, follows, reactions, rooms, challenges, devices), as deleting an
   * account does. Nothing outside the world changes, and its entered email is free again.
   */
  async deleteWorld(adminId: string, worldId: number, reason?: string): Promise<{ deleted: true }> {
    const world = await this.worldOrThrow(worldId);
    const ids = world.accounts.map((a) => a.userId);
    await this.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await this.audit.record({
      adminId,
      action: 'demo.world.delete',
      targetType: 'demo_world',
      targetId: String(worldId),
      reason: `Demo world ${worldId}: ${ids.length} accounts${reason ? `. ${reason}` : ''}`,
    });
    return { deleted: true };
  }

  /**
   * Whether a push sent since `since` reached the phone, from Expo's receipts after a moment:
   * null when one device took it; else the first error. Tokens of an old install
   * (DeviceNotRegistered) are forgotten at once, as the receipt job would later.
   */
  private async receiptError(since: Date): Promise<string | null> {
    const jobs = await this.prisma.job.findMany({
      where: { kind: PUSH_RECEIPTS_JOB, createdAt: { gte: since } },
      select: { payload: true },
    });
    const tickets = jobs.flatMap(
      (job) => (job.payload as { tickets?: { id: string; token: string }[] }).tickets ?? [],
    );
    if (tickets.length === 0) return null;
    if (RECEIPT_WAIT_MS > 0) await new Promise((resolve) => setTimeout(resolve, RECEIPT_WAIT_MS));
    let receipts: Record<string, PushReceipt>;
    try {
      receipts = await this.modules
        .get(PushTransport, { strict: false })
        .receipts(tickets.map((ticket) => ticket.id));
    } catch {
      return null; // Receipts not reachable now: the push still went out.
    }
    const gone = tickets.filter((ticket) => {
      const receipt = receipts[ticket.id];
      return receipt?.status === 'error' && receipt.error === 'DeviceNotRegistered';
    });
    if (gone.length > 0) {
      await this.prisma.pushDevice.deleteMany({
        where: { token: { in: gone.map((ticket) => ticket.token) } },
      });
    }
    for (const ticket of tickets) {
      const receipt = receipts[ticket.id];
      if (receipt?.status === 'error') {
        new Logger('DemoTools').warn(
          `Push not delivered: ${receipt.error}${receipt.message ? `: ${receipt.message}` : ''}`,
        );
      }
    }
    const errors = tickets.map((ticket) => receipts[ticket.id]);
    if (errors.some((receipt) => !receipt || receipt.status === 'ok')) return null;
    const first = errors.find((receipt) => receipt?.status === 'error');
    return first?.status === 'error' ? first.error : null;
  }

  /** A fresh waiting room for the presenter, in place of one that ran out. */
  async openRoom(adminId: string, worldId: number): Promise<{ opened: true }> {
    const world = await this.worldOrThrow(worldId);
    const main = DemoService.user(world, 'main');
    await this.waitingRoom(main, DemoService.user(world, 'friend-linh'));
    this.live.announce(main, { type: 'refresh', reason: 'room' });
    await this.audit.record({
      adminId,
      action: 'demo.room',
      targetType: 'user',
      targetId: main,
      reason: `Demo world ${worldId}`,
    });
    return { opened: true };
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

  /**
   * Adds a session that just finished, through the real submission (growth, badges, streak,
   * challenges), and sends its result to the phone, which celebrates it as its own.
   */
  async addSession(
    adminId: string,
    worldId: number,
    persona: DemoPersona,
    minutes: number,
  ): Promise<unknown> {
    const world = await this.worldOrThrow(worldId);
    const userId = DemoService.user(world, persona);
    const now = this.clock.now();
    const end = new Date(now.getTime() - 30_000);
    const start = new Date(end.getTime() - minutes * MIN);
    const last = await this.prisma.focusSession.findFirst({
      where: { userId },
      orderBy: { effectiveEndedAt: 'desc' },
      select: { effectiveEndedAt: true },
    });
    if (last && last.effectiveEndedAt > start) {
      const wait = Math.ceil((last.effectiveEndedAt.getTime() - start.getTime()) / MIN);
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `The last session ended moments ago: wait ${wait} more minute${wait === 1 ? '' : 's'}, or add a shorter one.`,
        code: 'too_soon',
      });
    }
    const topic = await this.prisma.topic.findFirst({
      where: { userId, status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!topic) throw new BadRequestException('This account has no topic.');
    const { session } = await this.sessions.submit(userId, randomUUID(), {
      topicId: topic.id,
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      plannedMinutes: minutes,
      pauseIntervals: [],
    });
    this.live.announce(userId, { type: 'session', session });
    await this.audit.record({
      adminId,
      action: 'demo.session',
      targetType: 'user',
      targetId: userId,
      reason: `Demo world ${worldId}: ${minutes} minutes`,
    });
    return session;
  }

  /** Makes today a rest day, under the product's own rules (two a week). */
  async restToday(adminId: string, worldId: number, persona: DemoPersona): Promise<unknown> {
    const world = await this.worldOrThrow(worldId);
    const userId = DemoService.user(world, persona);
    const result = await this.restDays.schedule(userId, localToday(this.clock.now()));
    this.live.announce(userId, { type: 'refresh', reason: 'rest_day' });
    await this.audit.record({
      adminId,
      action: 'demo.rest_today',
      targetType: 'user',
      targetId: userId,
      reason: `Demo world ${worldId}`,
    });
    return result.restDays;
  }

  /** A friend reacts to the presenter's forest with something they have not sent yet. */
  async react(adminId: string, worldId: number, persona: DemoPersona): Promise<unknown> {
    const world = await this.worldOrThrow(worldId);
    if (!persona.startsWith('friend-')) throw new BadRequestException('Only a friend reacts.');
    const friend = DemoService.user(world, persona);
    const main = DemoService.user(world, 'main');
    const sent = await this.prisma.reaction.findMany({
      where: { reactorId: friend, ownerId: main, targetType: 'forest' },
      select: { reaction: true },
    });
    const kinds = ['fire', 'sprout', 'clap', 'heart', 'sparkles'] as const;
    const kind = kinds.find((k) => !sent.some((r) => r.reaction === k)) ?? 'sparkles';
    const summary = await this.reactions.add(friend, main, { type: 'forest', key: '' }, kind);
    this.live.announce(main, { type: 'refresh', reason: 'reaction' });
    await this.audit.record({
      adminId,
      action: 'demo.react',
      targetType: 'user',
      targetId: main,
      reason: `Demo world ${worldId}: ${persona} sent ${kind}`,
    });
    return summary;
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

  private subject(category: DemoCategory, now: Date, time: string): string | null {
    if (isReminder(category)) return `${localToday(now)} ${time}`;
    return null;
  }

  private copy(category: DemoCategory, now: Date): NotificationCopyInput {
    switch (category) {
      case 'dailyGoalReminder':
        return { category, goalMinutes: 30 };
      case 'scheduledFocusReminder':
        return { category };
      case 'streakReminder':
        return { category, streakDays: 6 };
      case 'badgeUnlocked':
        return { category, badgeName: 'Early Bird' };
      case 'monthlyRecapReady': {
        const last = lastMonth(now);
        return { category, year: last.year, month: last.month };
      }
      default:
        throw new BadRequestException(`${category} goes through its own flow.`);
    }
  }

  private link(category: DemoCategory, now: Date): string {
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
