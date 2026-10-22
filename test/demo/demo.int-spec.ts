import { randomUUID } from 'node:crypto';

import { createAdmin } from '../../src/admin/create-admin.js';
import { AuthService } from '../../src/identity/auth.service.js';
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
/** The one password of every demo address (`demoN…@focusforest.test`). */
const DEMO_PASSWORD = 'focus-forest-demo';
/** Real sign-ups in these tests. */
const USER_PASSWORD = 'demo-password-1';
const hasher = new PasswordHasher({ cost: 2 ** 10 });
type Auth = Record<string, string>;
type Body = Record<string, unknown>;
const MIN = 60_000;

async function admin(email: string, role: 'admin' | 'support' = 'admin'): Promise<Auth> {
  await createAdmin(t.prisma, hasher, { email, role, password: ADMIN_PASSWORD });
  const res = await t.http().post('/admin/auth/sign-in').send({ email, password: ADMIN_PASSWORD });
  return { Authorization: `Bearer ${(res.body as { accessToken: string }).accessToken}` };
}
/**
 * Signs an account in: a demo address with the shared password, a real sign-up with its own,
 * and an account with no password (an email the admin entered, which signs in with Google on
 * the phone) through a session started directly, as Google sign-in would.
 */
async function signIn(email: string): Promise<Auth> {
  const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
  if (!user.passwordHash) {
    const session = await t.app.get(AuthService).startSession(user);
    return { Authorization: `Bearer ${session.accessToken}` };
  }
  const password = email.endsWith('@focusforest.test') ? DEMO_PASSWORD : USER_PASSWORD;
  const res = await t.http().post('/auth/sign-in').send({ email, password }).expect(200);
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
    .send({ reason: 'Demo for the team' })
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
    await t.http().post('/admin/demo/worlds').set(support).send({}).expect(403);
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

  it('makes the accounts with the emails the admin enters, and fills in the rest', async () => {
    const res = await t
      .http()
      .post('/admin/demo/worlds')
      .set(auth)
      .send({
        emails: { main: '  Bill.Presenter@Gmail.com ', 'friend-khoa': 'khoa@team.dev' },
      })
      .expect(201);
    const world = res.body as World;
    expect(account(world, 'main').email).toBe('bill.presenter@gmail.com');
    expect(account(world, 'friend-khoa').email).toBe('khoa@team.dev');
    expect(account(world, 'comeback').email).toBe(`demo${world.id}-comeback@focusforest.test`);
    // Listed as a demo world although the addresses are the admin's own.
    const list = await t.http().get('/admin/demo/worlds').set(auth).expect(200);
    expect((list.body as { items: World[] }).items[0]!.accounts).toEqual(world.accounts);
    // The main account is poised as usual and signs in with the entered address.
    const main = await signIn('bill.presenter@gmail.com');
    const home = await t.http().get('/me/home').set(main).expect(200);
    expect(home.body).toMatchObject({ pendingCeremony: { year: 2026, month: 9 } });
  });

  it('needs no password: entered emails sign in with Google, demo addresses with one shared password', async () => {
    const res = await t
      .http()
      .post('/admin/demo/worlds')
      .set(auth)
      .send({ emails: { main: 'bill.presenter@gmail.com' } })
      .expect(201);
    const world = res.body as World & {
      accounts: { persona: string; signIn: string; password: string | null }[];
    };
    const main = world.accounts.find((a) => a.persona === 'main')!;
    const comeback = world.accounts.find((a) => a.persona === 'comeback')!;
    expect(main).toMatchObject({ signIn: 'google', password: null });
    expect(comeback).toMatchObject({ signIn: 'password', password: 'focus-forest-demo' });
    // The Gmail account has no password at all; the demo address signs in with the shared one.
    const owner = await t.prisma.user.findUniqueOrThrow({
      where: { email: 'bill.presenter@gmail.com' },
    });
    expect(owner.passwordHash).toBeNull();
    await t
      .http()
      .post('/auth/sign-in')
      .send({ email: comeback.email, password: 'focus-forest-demo' })
      .expect(200);
    // Listed the same way.
    const list = await t.http().get('/admin/demo/worlds').set(auth).expect(200);
    expect((list.body as { items: World[] }).items[0]!.accounts).toEqual(world.accounts);
  });

  it('never takes over an existing account, and refuses a bad or repeated email', async () => {
    await t
      .http()
      .post('/auth/sign-up')
      .send({ email: 'real@example.com', password: USER_PASSWORD });
    const make = (emails: Record<string, string>) =>
      t.http().post('/admin/demo/worlds').set(auth).send({ emails });
    const taken = await make({ main: 'Real@example.com' }).expect(409);
    expect(taken.body).toMatchObject({ code: 'email_taken', email: 'real@example.com' });
    await make({ main: 'not-an-email' }).expect(400);
    await make({ stranger: 'x@team.dev' }).expect(400);
    const repeated = await make({ main: 'a@team.dev', comeback: 'A@team.dev' }).expect(400);
    expect(repeated.body).toMatchObject({ code: 'email_repeated' });
    // Nothing half-made.
    expect(await t.prisma.user.count()).toBe(1);
    expect((await t.http().get('/admin/demo/worlds').set(auth).expect(200)).body).toEqual({
      items: [],
    });
  });

  it('plays the planting ceremony on the main account’s first open', async () => {
    const world = await makeWorld(auth);
    const main = await signIn(account(world, 'main').email);
    const home = await t.http().get('/me/home').set(main).expect(200);
    expect(home.body).toMatchObject({ pendingCeremony: { year: 2026, month: 9 } });
    const streak = await t.http().get('/me/streak').set(main).expect(200);
    expect(streak.body).toMatchObject({ current: 6 });
  });

  it('turns one 5-minute session into a Mature Tree, 50 Hours, a 7-day streak, and a Community Tree milestone', async () => {
    const world = await makeWorld(auth);
    const main = await signIn(account(world, 'main').email);
    await t.http().get('/me/home').set(main).expect(200);
    // The shortest counted session, so the presenter shows it live (owner, 2026-10-22).
    const result = await focusNow(main, 5);
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

  it('starts with a waiting room the presenter is invited to, a friend already ready', async () => {
    const world = await makeWorld(auth);
    const main = await signIn(account(world, 'main').email);
    const invites = await t.http().get('/me/room-invites').set(main).expect(200);
    const items = (invites.body as { items: { room: { id: string; participants: unknown[] } }[] })
      .items;
    expect(items).toHaveLength(1);
    const room = JSON.stringify(items[0]!.room);
    expect(room).toContain('Mai');
    expect(room).toContain('Khoa');
    expect(room).toContain('"state":"ready"');
  });

  it('has followers beyond the three friends', async () => {
    const world = await makeWorld(auth);
    const main = await signIn(account(world, 'main').email);
    const followers = await t.http().get('/me/followers').set(main).expect(200);
    expect((followers.body as { items: unknown[] }).items).toHaveLength(5);
  });

  it('opens a fresh waiting room when asked, closing the old one', async () => {
    const world = await makeWorld(auth);
    const main = await signIn(account(world, 'main').email);
    const before = (
      (await t.http().get('/me/room-invites').set(main).expect(200)).body as {
        items: { room: { id: string } }[];
      }
    ).items[0]!.room.id;
    await t.http().post(`/admin/demo/worlds/${world.id}/room`).set(auth).send({}).expect(201);
    const after = (
      (await t.http().get('/me/room-invites').set(main).expect(200)).body as {
        items: { room: { id: string } }[];
      }
    ).items;
    expect(after).toHaveLength(1);
    expect(after[0]!.room.id).not.toBe(before);
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

/** The demo live channel (`/demo/live`): what an admin changes reaches the phone at once. */
interface Live {
  socket: WebSocket;
  next: (type: string, ms?: number) => Promise<Body>;
}
async function live(token: string): Promise<Live> {
  const socket = new WebSocket(`${t.url.replace(/^http/, 'ws')}/demo/live`);
  const messages: Body[] = [];
  socket.addEventListener('message', (event) =>
    messages.push(JSON.parse(String(event.data)) as Body),
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('socket error')));
  });
  socket.send(JSON.stringify({ type: 'auth', token }));
  return {
    socket,
    next: async (type, ms = 4000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const i = messages.findIndex((m) => m['type'] === type);
        if (i >= 0) return messages.splice(i, 1)[0]!;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`No ${type} message; got ${JSON.stringify(messages)}`);
    },
  };
}
const tokenOf = (auth: Auth) => auth['Authorization']!.replace('Bearer ', '');

describe('demo live changes (DM.1b)', () => {
  let auth: Auth;
  const sockets: WebSocket[] = [];
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
  afterEach(() => {
    for (const s of sockets.splice(0)) s.close();
  });
  const open = async (token: string) => {
    const l = await live(token);
    sockets.push(l.socket);
    return l;
  };

  it('lets only demo accounts listen', async () => {
    const world = await makeWorld(auth);
    const main = await open(tokenOf(await signIn(account(world, 'main').email)));
    expect(await main.next('authenticated')).toEqual({ type: 'authenticated' });
    await t
      .http()
      .post('/auth/sign-up')
      .send({ email: 'real@example.com', password: USER_PASSWORD });
    const real = await open(tokenOf(await signIn('real@example.com')));
    expect(await real.next('error')).toEqual({ type: 'error', code: 'not_a_demo_account' });
  });

  it('lets a demo account with an entered email listen', async () => {
    const res = await t
      .http()
      .post('/admin/demo/worlds')
      .set(auth)
      .send({ emails: { main: 'presenter@team.dev' } })
      .expect(201);
    expect((res.body as World).accounts[0]!.email).toBe('presenter@team.dev');
    const main = await open(tokenOf(await signIn('presenter@team.dev')));
    expect(await main.next('authenticated')).toEqual({ type: 'authenticated' });
  });

  it('adds a finished session from the admin and sends its result to the phone', async () => {
    const world = await makeWorld(auth);
    const main = await open(tokenOf(await signIn(account(world, 'main').email)));
    await main.next('authenticated');
    const res = await t
      .http()
      .post(`/admin/demo/worlds/${world.id}/session`)
      .set(auth)
      .send({ persona: 'main', minutes: 25 })
      .expect(201);
    expect(JSON.stringify(res.body)).toContain('mature_tree');
    const pushed = await main.next('session');
    expect(JSON.stringify(pushed['session'])).toContain('focus-hours:50');
  });

  it('says to wait when the last session ended moments ago', async () => {
    const world = await makeWorld(auth);
    await t
      .http()
      .post(`/admin/demo/worlds/${world.id}/session`)
      .set(auth)
      .send({ persona: 'main', minutes: 25 })
      .expect(201);
    const again = await t
      .http()
      .post(`/admin/demo/worlds/${world.id}/session`)
      .set(auth)
      .send({ persona: 'main', minutes: 25 })
      .expect(409);
    expect(again.body).toMatchObject({ code: 'too_soon' });
  });

  it('makes today a rest day and tells the phone to refresh', async () => {
    const world = await makeWorld(auth);
    const mainAuth = await signIn(account(world, 'main').email);
    const main = await open(tokenOf(mainAuth));
    await main.next('authenticated');
    await t
      .http()
      .post(`/admin/demo/worlds/${world.id}/rest-today`)
      .set(auth)
      .send({ persona: 'main' })
      .expect(201);
    expect(await main.next('refresh')).toMatchObject({ type: 'refresh' });
    const rest = await t.http().get('/me/rest-days').set(mainAuth).expect(200);
    expect(JSON.stringify(rest.body)).toContain('2026-10-20');
  });

  it('has a friend react to the presenter’s forest, and tells the phone', async () => {
    const world = await makeWorld(auth);
    const main = await open(tokenOf(await signIn(account(world, 'main').email)));
    await main.next('authenticated');
    await t
      .http()
      .post(`/admin/demo/worlds/${world.id}/react`)
      .set(auth)
      .send({ persona: 'friend-linh' })
      .expect(201);
    expect(await main.next('refresh')).toMatchObject({ type: 'refresh' });
  });
});
