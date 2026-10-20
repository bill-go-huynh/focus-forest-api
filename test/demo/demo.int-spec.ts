import { randomUUID } from 'node:crypto';

import { createAdmin } from '../../src/admin/create-admin.js';
import { PasswordHasher } from '../../src/identity/password-hasher.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * DM.1 Demo tools (spec/demo/PLAN.md): an admin makes a fresh demo world whose accounts are
 * poised so one real session shows what normally takes weeks or many people, and can send any
 * notification at once. Local only: off unless DEMO_TOOLS=on, never in production; admin role
 * only; every action audited.
 */

// 12:00 in Ho Chi Minh City on 20 October.
const t = new ConsistencyHarness('2026-10-20T05:00:00.000Z');
const ADMIN_PASSWORD = 'correct horse battery staple admin';
const DEMO_PASSWORD = 'demo-password-1';
const hasher = new PasswordHasher({ cost: 2 ** 10 });
type Auth = Record<string, string>;
type Body = Record<string, unknown>;
const MIN = 60_000;

async function admin(email: string, role: 'admin' | 'support' = 'admin'): Promise<Auth> {
  await createAdmin(t.prisma, hasher, { email, role, password: ADMIN_PASSWORD });
  const res = await t.http().post('/admin/auth/sign-in').send({ email, password: ADMIN_PASSWORD });
  return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
}
async function signIn(email: string): Promise<Auth> {
  const res = await t
    .http()
    .post('/auth/sign-in')
    .send({ email, password: DEMO_PASSWORD })
    .expect(200);
  return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
}
interface World {
  id: number;
  eventId: string;
  accounts: { persona: string; email: string; userId: string }[];
}
async function makeWorld(auth: Auth): Promise<World> {
  const res = await t
    .http()
    .post('/admin/demo/worlds')
    .set(auth)
    .send({ password: DEMO_PASSWORD, reason: 'Demo for the team' })
    .expect(201);
  return res.body as World;
}
const account = (world: World, persona: string) =>
  world.accounts.find((a) => a.persona === persona)!;
async function topicOf(auth: Auth): Promise<string> {
  const res = await t.http().get('/me/topics').set(auth).expect(200);
  return (res.body as { id: string }[])[0]!.id;
}
/** A real session from the phone: `minutes` ending a minute ago. */
async function focusNow(auth: Auth, minutes: number) {
  const end = t.clock.now().getTime() - MIN;
  const res = await t
    .http()
    .put(`/me/sessions/${randomUUID()}`)
    .set(auth)
    .send({
      topicId: await topicOf(auth),
      startedAt: new Date(end - minutes * MIN).toISOString(),
      endedAt: new Date(end).toISOString(),
      plannedMinutes: minutes,
      pauseIntervals: [],
    });
  expect([200, 201]).toContain(res.status);
  return res.body as Body;
}

describe('demo tools (DM.1)', () => {
  let auth: Auth;
  beforeAll(async () => {
    await t.start();
  });
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-20T05:00:00.000Z');
    await t.activateConfig();
    auth = await admin('ops@example.com');
  });

  it('says it is on, and is for the admin role only', async () => {
    const status = await t.http().get('/admin/demo/status').set(auth).expect(200);
    expect(status.body).toEqual({ enabled: true });
    const support = await admin('support@example.com', 'support');
    await t
      .http()
      .post('/admin/demo/worlds')
      .set(support)
      .send({ password: DEMO_PASSWORD })
      .expect(403);
  });

  it('makes a world of five accounts and an event, and lists it', async () => {
    const world = await makeWorld(auth);
    expect(world.accounts.map((a) => a.persona)).toEqual([
      'main',
      'comeback',
      'recovery',
      'friend-mai',
      'friend-khoa',
      'friend-linh',
    ]);
    const list = await t.http().get('/admin/demo/worlds').set(auth).expect(200);
    expect((list.body as { items: World[] }).items.map((w) => w.id)).toEqual([world.id]);
    const audit = await t.prisma.adminAuditLog.findMany({ where: { action: 'demo.world.create' } });
    expect(audit).toHaveLength(1);
  });

  it('plays the planting ceremony on the main account’s first open', async () => {
    const world = await makeWorld(auth);
    const main = await signIn(account(world, 'main').email);
    const home = await t.http().get('/me/home').set(main).expect(200);
    expect(home.body).toMatchObject({ pendingCeremony: { year: 2026, month: 9 } });
    const streak = await t.http().get('/me/streak').set(main).expect(200);
    expect(streak.body).toMatchObject({ current: 6 });
  });

  it('turns one 25-minute session into a Mature Tree, 50 Hours, a 7-day streak, and a Community Tree milestone', async () => {
    const world = await makeWorld(auth);
    const main = await signIn(account(world, 'main').email);
    await t.http().get('/me/home').set(main).expect(200);
    const result = await focusNow(main, 25);
    expect(JSON.stringify(result.growth)).toContain('mature_tree');
    const badges = JSON.stringify(result.progression);
    expect(badges).toContain('focus-hours:50');
    expect(badges).toContain('focus-streak:7');
    const tree = await t
      .http()
      .get(`/events/${world.eventId}/community-tree`)
      .set(main)
      .expect(200);
    expect(JSON.stringify(tree.body)).toContain('reached');
  });

  it('gives the comeback account a quiet tree that wakes with a session', async () => {
    const world = await makeWorld(auth);
    const comeback = await signIn(account(world, 'comeback').email);
    const before = await t.http().get('/me/home').set(comeback).expect(200);
    expect(JSON.stringify(before.body)).toContain('"vitality":"quiet"');
    await focusNow(comeback, 15);
    const after = await t.http().get('/me/home').set(comeback).expect(200);
    expect(JSON.stringify(after.body)).toContain('"vitality":"recovering"');
  });

  it('offers the recovery account its streak back after a session today', async () => {
    const world = await makeWorld(auth);
    const recovery = await signIn(account(world, 'recovery').email);
    await focusNow(recovery, 15);
    const streak = await t.http().get('/me/streak').set(recovery).expect(200);
    expect(streak.body).toMatchObject({ recovery: { offer: { missedDate: '2026-10-19' } } });
  });

  it('makes the main account a friend of three, who are on the leaderboard', async () => {
    const world = await makeWorld(auth);
    const main = await signIn(account(world, 'main').email);
    const following = await t.http().get('/me/following').set(main).expect(200);
    expect((following.body as { items: unknown[] }).items).toHaveLength(3);
  });

  it('sends any notification at once, through the real pipeline, and says what became of it', async () => {
    const world = await makeWorld(auth);
    const main = await signIn(account(world, 'main').email);
    await t
      .http()
      .put(`/me/devices/${encodeURIComponent('ExponentPushToken[demo-phone]')}`)
      .set(main)
      .send({ platform: 'android' })
      .expect(200);
    const res = await t
      .http()
      .post(`/admin/demo/worlds/${world.id}/notify`)
      .set(auth)
      .send({ persona: 'main', category: 'monthlyRecapReady' })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'sent' });
    expect(t.push.messages.at(-1)).toMatchObject({ title: 'Your September recap is ready' });

    for (const category of [
      'badgeUnlocked',
      'eventStart',
      'friendInvite',
      'focusRoomInvite',
      'challengeUpdate',
    ]) {
      const sent = await t
        .http()
        .post(`/admin/demo/worlds/${world.id}/notify`)
        .set(auth)
        .send({ persona: 'main', category })
        .expect(201);
      expect([category, sent.body]).toEqual([
        category,
        expect.objectContaining({ status: 'sent' }),
      ]);
    }
  });

  it('says why a notification could not go: no phone registered', async () => {
    const world = await makeWorld(auth);
    const res = await t
      .http()
      .post(`/admin/demo/worlds/${world.id}/notify`)
      .set(auth)
      .send({ persona: 'main', category: 'badgeUnlocked' })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'skipped', reason: 'no_device' });
  });

  it('lets a friend join the presenter’s lobby and get ready', async () => {
    const world = await makeWorld(auth);
    const main = await signIn(account(world, 'main').email);
    await t
      .http()
      .post('/admin/demo/worlds/' + world.id + '/friend-ready')
      .set(auth)
      .send({})
      .expect(409);
    await t
      .http()
      .post('/rooms')
      .set(main)
      .send({ name: 'Demo room', durationMinutes: 25, maxParticipants: 4, visibility: 'private' })
      .expect(201);
    const res = await t
      .http()
      .post(`/admin/demo/worlds/${world.id}/friend-ready`)
      .set(auth)
      .send({})
      .expect(201);
    expect(JSON.stringify(res.body)).toContain('"state":"ready"');
  });
});
