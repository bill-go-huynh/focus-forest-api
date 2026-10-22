import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { JobsService } from '../../src/jobs/jobs.service.js';
import { BackgroundWorker } from '../../src/notifications/background-worker.js';
import { guiltProblems } from '../../src/notifications/notification-copy.js';
import { isKnownLink } from '../../src/notifications/notification-links.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';
import { normalize } from '../support/contract-normalize.js';

/**
 * X6 Notifications integration (HTTP + PostgreSQL + the background worker), one day for three
 * friends in two time zones, with every job and dispatch driven by `BackgroundWorker.tick` each
 * quarter hour, as in production, and pushes recorded by the harness:
 *
 * 1. Reminders arrive at each person's local time (Ho Chi Minh City, Berlin).
 * 2. A category someone turned off is never sent to them.
 * 3. Two informational notices a local day: the third is dropped; reminders the person set are
 *    not counted.
 * 4. Nothing arrives during a focus lease or a Focus Together session. When focus ends, what it
 *    held back arrives, or is dropped if it expired meanwhile.
 * 5. No copy shames or pressures; every link is one the app opens.
 * 6. What the app reads is captured (`notifications-contract.json`, byte-identical with
 *    focus-forest-mobile `src/test-utils/x6/notifications-contract.json`). After an intended
 *    change: `X6_UPDATE_CONTRACT=1 npm run test:int -- test/x6`, then copy the file.
 */

const FILE = fileURLToPath(new URL('./notifications-contract.json', import.meta.url));
const DAY = '2026-11-02';
const t = new ConsistencyHarness(`${DAY}T08:45:00.000Z`);
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;

describe('X6 notifications integration (HTTP + PostgreSQL + worker)', () => {
  let worker: BackgroundWorker;
  let jobs: JobsService;

  beforeAll(async () => {
    await t.start();
    worker = t.app.get(BackgroundWorker);
    jobs = t.app.get(JobsService);
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    t.push.reset();
    await t.setNow(`${DAY}T08:45:00.000Z`);
    await t.activateConfig();
  });

  it('delivers each notice at the right local time, never while focusing, within the limit', async () => {
    const c: Record<string, unknown> = {};
    const send = async (
      user: User,
      method: 'get' | 'put' | 'post' | 'patch' | 'delete',
      path: string,
      body?: object,
      status = 200,
    ) =>
      (
        await t
          .http()
          [method](path)
          .set(user.auth)
          .send(body ?? {})
          .expect(status)
      ).body as unknown;

    /** Someone with a device and these notifications on (reminders with their local time). */
    const person = async (
      name: string,
      timezone: string,
      notifications: Record<string, { enabled: boolean; time?: string }>,
    ) => {
      const user = await t.signUp(`${name}@example.com`, timezone, '2026-09-01T00:00:00.000Z');
      await send(user, 'patch', '/me/profile', { username: name });
      const device = await send(
        user,
        'put',
        `/me/devices/${encodeURIComponent(`ExponentPushToken[${name}]`)}`,
        { platform: 'ios', appVersion: '1.0.0' },
      );
      const preferences = await send(user, 'patch', '/me/preferences', { notifications });
      return { user, device, preferences };
    };

    // Mai in Ho Chi Minh City (UTC+7), Lukas in Berlin (UTC+1 in November), Linh in Ho Chi Minh
    // City with room invitations left off.
    const mai = await person('mai', 'Asia/Ho_Chi_Minh', {
      dailyGoalReminder: { enabled: true, time: '20:00' },
      friendInvite: { enabled: true },
      focusRoomInvite: { enabled: true },
    });
    const lukas = await person('lukas', 'Europe/Berlin', {
      dailyGoalReminder: { enabled: true, time: '20:00' },
    });
    const linh = await person('linh', 'Asia/Ho_Chi_Minh', {
      dailyGoalReminder: { enabled: true, time: '18:00' },
      friendInvite: { enabled: true },
    });
    c['deviceRegistered'] = mai.device;
    c['preferences'] = mai.preferences;
    for (const [a, b] of [
      [mai, lukas],
      [mai, linh],
    ] as const) {
      await send(a.user, 'put', `/me/following/${b.user.userId}`);
      await send(b.user, 'put', `/me/following/${a.user.userId}`);
    }

    // The worker runs every recurring job and every due notification, a quarter hour at a time.
    await jobs.startRecurring(t.clock.now());
    // Ticks fall on the quarter hours, as the worker's recurring jobs do.
    const QUARTER = 15 * 60_000;
    const runUntil = async (iso: string) => {
      let at = Math.ceil(t.clock.now().getTime() / QUARTER) * QUARTER;
      const end = Date.parse(iso);
      while (at <= end) {
        await t.setNow(new Date(at).toISOString());
        await worker.tick(new Date(at));
        at += QUARTER;
      }
    };
    const pushed = () => t.push.messages.map((m) => `${m.to.slice(18, -1)} ${m.data.category}`);

    // 10:00: Lukas opens a room and invites Mai (her first notice today), then leaves it.
    await runUntil(`${DAY}T09:45:00.000Z`);
    await t.setNow(`${DAY}T10:00:00.000Z`);
    const morning = (await send(
      lukas.user,
      'post',
      '/rooms',
      { name: 'Morning focus', durationMinutes: 25, maxParticipants: 4, visibility: 'private' },
      201,
    )) as { id: string };
    await send(lukas.user, 'post', `/rooms/${morning.id}/invites`, { userIds: [mai.user.userId] });
    await runUntil(`${DAY}T10:00:00.000Z`);
    await send(lukas.user, 'post', `/rooms/${morning.id}/leave`);
    expect(pushed()).toEqual(['mai focusRoomInvite']);

    // 10:20: Lukas invites Mai to a challenge (her second notice today).
    await t.setNow(`${DAY}T10:20:00.000Z`);
    c['challengeCreated'] = await send(
      lukas.user,
      'post',
      '/me/challenges',
      { templateId: 'steady-week-together', invite: [mai.user.userId] },
      201,
    );
    // 10:25: Linh starts focusing for three hours; the app holds a lease until then.
    await t.setNow(`${DAY}T10:25:00.000Z`);
    c['leaseSet'] = await send(linh.user, 'put', '/me/focus/active', {
      endsAt: `${DAY}T13:25:00.000Z`,
    });
    await runUntil(`${DAY}T10:30:00.000Z`);
    expect(pushed().slice(1)).toEqual(['mai friendInvite']);

    // 10:40: Linh opens a room and invites Mai: a third notice for Mai today, so it is dropped.
    await t.setNow(`${DAY}T10:40:00.000Z`);
    const room = (await send(
      linh.user,
      'post',
      '/rooms',
      { name: 'Evening study', durationMinutes: 25, maxParticipants: 4, visibility: 'private' },
      201,
    )) as { id: string };
    c['roomInvited'] = await send(linh.user, 'post', `/rooms/${room.id}/invites`, {
      userIds: [mai.user.userId],
    });
    // Mai still sees the invitation in the app.
    c['roomInvites'] = await send(mai.user, 'get', '/me/room-invites');
    expect((c['roomInvites'] as { items: unknown[] }).items).toHaveLength(1);

    // 12:00: Mai invites Linh to a challenge while Linh is focusing: held back.
    await t.setNow(`${DAY}T12:00:00.000Z`);
    await send(
      mai.user,
      'post',
      '/me/challenges',
      { templateId: 'steady-week-together', invite: [linh.user.userId] },
      201,
    );
    // And to a room, which Linh never turned on: never sent, focus or not. Mai then leaves it.
    const lunch = (await send(
      mai.user,
      'post',
      '/rooms',
      { name: 'Lunch focus', durationMinutes: 25, maxParticipants: 4, visibility: 'private' },
      201,
    )) as { id: string };
    await send(mai.user, 'post', `/rooms/${lunch.id}/invites`, { userIds: [linh.user.userId] });
    await send(mai.user, 'post', `/rooms/${lunch.id}/leave`);
    // Linh's 18:00 reminder (11:00 UTC) and the invitation wait while she focuses; Mai's 20:00
    // reminder (13:00 UTC) arrives though she reached today's limit: she asked for it.
    await runUntil(`${DAY}T13:15:00.000Z`);
    expect(pushed().slice(2)).toEqual(['mai dailyGoalReminder']);

    // 13:25: Linh's focus ends. The invitation arrives; her reminder expired at 13:00.
    await t.setNow(`${DAY}T13:25:00.000Z`);
    await send(linh.user, 'delete', '/me/focus/active', undefined, 204);
    await runUntil(`${DAY}T13:30:00.000Z`);
    expect(pushed().slice(3)).toEqual(['linh friendInvite']);

    // 18:40: Lukas and Mai focus together; Lukas's 20:00 reminder (19:00 UTC) waits for it.
    await t.setNow(`${DAY}T18:40:00.000Z`);
    const together = (await send(
      lukas.user,
      'post',
      '/rooms',
      { name: 'Focus hour', durationMinutes: 50, maxParticipants: 2, visibility: 'public' },
      201,
    )) as { id: string };
    await send(mai.user, 'post', `/rooms/${together.id}/join`);
    await send(lukas.user, 'put', `/rooms/${together.id}/ready`);
    await send(mai.user, 'put', `/rooms/${together.id}/ready`);
    await runUntil(`${DAY}T19:00:00.000Z`);
    expect(pushed()).toHaveLength(4);

    // 19:10: Lukas leaves; the app ends his focus, and his reminder arrives.
    await t.setNow(`${DAY}T19:10:00.000Z`);
    await send(lukas.user, 'post', `/rooms/${together.id}/leave`);
    await send(lukas.user, 'delete', '/me/focus/active', undefined, 204);
    await runUntil(`${DAY}T19:15:00.000Z`);
    expect(pushed().slice(4)).toEqual(['lukas dailyGoalReminder']);

    // What became of every notice.
    const rows = await t.prisma.notificationOutbox.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { user: { select: { username: true } } },
    });
    const outcome = (name: string, category: string) =>
      rows
        .filter((row) => row.user.username === name && row.category === category)
        .map((row) => [row.status, row.reason]);
    expect(outcome('mai', 'focusRoomInvite')).toEqual([
      ['sent', null],
      ['skipped', 'daily_limit'],
    ]);
    expect(outcome('linh', 'dailyGoalReminder')).toEqual([['skipped', 'expired']]);
    expect(outcome('linh', 'focusRoomInvite')).toEqual([['skipped', 'category_off']]);
    expect(rows.filter((row) => row.status === 'sent')).toHaveLength(5);

    // Calm copy, and links the app opens.
    for (const message of t.push.messages) {
      expect(guiltProblems(`${message.title} ${message.body}`)).toEqual([]);
      expect(isKnownLink(message.data.link)).toBe(true);
    }
    expect(t.push.messages.map((m) => m.data.link)).toEqual([
      `/together/room/${morning.id}`,
      expect.stringMatching(/^\/together\/challenges\/[0-9a-f-]{36}$/),
      '/',
      expect.stringMatching(/^\/together\/challenges\/[0-9a-f-]{36}$/),
      '/',
    ]);

    // 6. The capture.
    c['pushes'] = t.push.messages.map(({ title, body, data }) => ({ title, body, data }));
    const replace = new Map<string, string>([
      [mai.user.userId, '00000000-0000-4000-8000-0000000006a1'],
      [lukas.user.userId, '00000000-0000-4000-8000-0000000006a2'],
      [linh.user.userId, '00000000-0000-4000-8000-0000000006a3'],
      [room.id, '00000000-0000-4000-8000-0000000006b1'],
      [together.id, '00000000-0000-4000-8000-0000000006b2'],
      [lunch.id, '00000000-0000-4000-8000-0000000006b3'],
      [morning.id, '00000000-0000-4000-8000-0000000006b4'],
      [`/together/room/${morning.id}`, '/together/room/00000000-0000-4000-8000-0000000006b4'],
    ]);
    const challengeIds = t.push.messages
      .map((m) => m.data.link.match(/^\/together\/challenges\/(.+)$/)?.[1])
      .filter((id): id is string => !!id);
    challengeIds.forEach((id, i) => {
      replace.set(id, `00000000-0000-4000-8000-0000000006c${i + 1}`);
      replace.set(
        `/together/challenges/${id}`,
        `/together/challenges/00000000-0000-4000-8000-0000000006c${i + 1}`,
      );
    });
    const code = (c['roomInvited'] as { code: string | null }).code;
    if (code) replace.set(code, 'CODE01');
    const captured = `${JSON.stringify(normalize(c, replace, new Map()), null, 2)}\n`;
    expect(captured).not.toMatch(/eyJ|password/);
    if (process.env['X6_UPDATE_CONTRACT'] === '1' || !existsSync(FILE)) {
      writeFileSync(FILE, captured);
    }
    expect(captured).toBe(readFileSync(FILE, 'utf8'));
    // A whole day, a quarter hour at a time: give a busy machine room.
  }, 120_000);
});
