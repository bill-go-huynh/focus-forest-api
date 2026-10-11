import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ConsistencyHarness } from '../support/consistency-harness.js';
import { normalize } from '../support/contract-normalize.js';
import { get, sid } from '../x3/x3-support.js';

/**
 * X5 Community & Live integration (HTTP + PostgreSQL), three people over the real API:
 *
 * 1. Privacy and blocks on every read: Kai blocks Mai, so Mai never finds or sees Kai (search,
 *    profile, forest, reactions, rooms, leaderboards), and Linh's private statistics stay hidden
 *    from her friend.
 * 2. A Focus Together session grows each person's own tree: Mai and Linh focus together, each
 *    submits their own session, and each tree grows by its owner's minutes only.
 * 3. One session advances the challenge, the event mission, and the Community Tree, and earns the
 *    season's reward, all from the same stored truth.
 * 4. Every answer the mobile app reads is captured (`community-contract.json`, byte-identical with
 *    focus-forest-mobile `src/test-utils/x5/community-contract.json`). After an intended change:
 *    `X5_UPDATE_CONTRACT=1 npm run test:int -- test/x5`, then copy the file.
 */

const FILE = fileURLToPath(new URL('./community-contract.json', import.meta.url));
const t = new ConsistencyHarness('2026-10-14T08:00:00.000Z');
type Body = Record<string, unknown>;
type User = Awaited<ReturnType<ConsistencyHarness['signUp']>>;
const MIN = 60_000;

const LIMITED = (from: string, until: string) => ({
  availability: 'limited' as const,
  availableFrom: new Date(from),
  availableUntil: new Date(until),
  status: 'active' as const,
});

/** An autumn event with a Community Tree and a board, and the northern autumn theme. */
async function content() {
  await t.prisma.cosmeticDefinition.createMany({
    data: [
      {
        id: 'maple-lanterns',
        type: 'decoration',
        rarity: 'rare',
        source: 'event',
        name: 'Maple Lanterns',
        description: 'Lanterns from the Autumn Study event.',
        artworkId: 'maple-lanterns',
        ...LIMITED('2026-10-13T00:00:00Z', '2026-10-29T00:00:00Z'),
      },
      {
        id: 'garden-lights',
        type: 'decoration',
        rarity: 'rare',
        source: 'event',
        name: 'Garden Lights',
        description: 'Lights from the shared garden.',
        artworkId: 'garden-lights',
        ...LIMITED('2026-10-13T00:00:00Z', '2026-10-29T00:00:00Z'),
      },
      {
        id: 'falling-leaves',
        type: 'decoration',
        rarity: 'common',
        source: 'season',
        name: 'Falling Leaves',
        description: 'Leaves drifting through the autumn forest.',
        artworkId: 'falling-leaves',
        ...LIMITED('2026-09-22T00:00:00Z', '2026-12-21T00:00:00Z'),
      },
    ],
  });
  await t.prisma.event.create({
    data: {
      id: 'autumn-study',
      name: 'Autumn Study',
      description: 'A week of steady autumn focus.',
      artworkId: 'autumn-study',
      status: 'active',
      startsAt: new Date('2026-10-13T00:00:00Z'),
      endsAt: new Date('2026-10-22T00:00:00Z'),
      leaderboard: true,
      missions: {
        create: [
          {
            id: 'one-hour',
            measure: 'focus_minutes',
            target: 60,
            name: 'Focus 1 hour',
            description: 'One hour of focus.',
            sortOrder: 1,
          },
          {
            id: 'together',
            measure: 'focus_together_sessions',
            target: 1,
            name: 'Focus together once',
            description: 'One Focus Together session.',
            sortOrder: 2,
          },
        ],
      },
      milestones: {
        create: [
          {
            id: 'first-leaf',
            requiredMissions: 1,
            cosmeticId: 'maple-lanterns',
            traitId: 'event:autumn-study',
            name: 'First leaf',
          },
        ],
      },
      communityTree: {
        create: {
          name: 'The Garden Oak',
          artworkId: 'garden-oak',
          milestones: {
            create: [
              { stage: 'seedling', thresholdMinutes: 60, cosmeticId: 'garden-lights' },
              { stage: 'bloom', thresholdMinutes: 600, cosmeticId: 'garden-lights' },
            ],
          },
        },
      },
    },
  });
  await t.prisma.seasonalTheme.create({
    data: {
      id: 'autumn-north',
      name: 'Autumn',
      description: 'Warm leaves and long light.',
      environmentId: 'autumn',
      hemisphere: 'north',
      status: 'active',
      startsAt: new Date('2026-09-22T00:00:00Z'),
      endsAt: new Date('2026-12-21T00:00:00Z'),
      rewards: { create: [{ id: 'leaves', cosmeticId: 'falling-leaves', requiredActiveDays: 1 }] },
    },
  });
}

describe('X5 Community & Live integration (HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-14T08:00:00.000Z');
    await t.activateConfig();
  });

  it('keeps privacy and blocks, grows each own tree, and counts one session everywhere', async () => {
    await content();
    const person = async (name: string): Promise<User> => {
      const user = await t.signUp(`${name}@example.com`, 'UTC', '2026-09-01T00:00:00.000Z');
      await t.http().patch('/me/profile').set(user.auth).send({ username: name }).expect(200);
      await t.http().patch('/me/privacy').set(user.auth).send({ leaderboards: true }).expect(200);
      return user;
    };
    const mai = await person('mai');
    const linh = await person('linh');
    const kai = await person('kai');
    const c: Record<string, unknown> = {};
    const send = async (
      user: User,
      method: 'put' | 'post' | 'delete',
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

    // Mai and Linh are friends; Kai follows Mai, then blocks her.
    await send(mai, 'put', `/me/following/${linh.userId}`);
    await send(linh, 'put', `/me/following/${mai.userId}`);
    await send(kai, 'put', `/me/following/${mai.userId}`);
    await send(kai, 'put', `/me/blocks/${mai.userId}`, undefined, 204);
    await t.focus(kai, [['2026-10-13', 90]]);
    await send(
      kai,
      'post',
      '/rooms',
      {
        name: 'Kai room',
        durationMinutes: 25,
        maxParticipants: 4,
        visibility: 'public',
      },
      201,
    );

    // 1. A block hides everything, both ways, the same as someone who does not exist.
    c['searchBlocked'] = await get(t, mai, '/users/search?q=kai');
    expect((c['searchBlocked'] as { items: unknown[] }).items).toEqual([]);
    c['profileBlocked'] = await get(t, mai, `/users/${kai.userId}/profile`, 404);
    await get(t, mai, `/users/${kai.userId}/forest`, 404);
    await get(t, mai, `/users/${kai.userId}/reactions?target=forest`, 404);
    await get(t, kai, `/users/${mai.userId}/profile`, 404);
    c['lobbies'] = await get(t, mai, '/rooms');
    expect((c['lobbies'] as { items: unknown[] }).items).toEqual([]);
    c['followers'] = await get(t, mai, '/me/followers');
    expect(
      (c['followers'] as { items: { username: string }[] }).items.map((p) => p.username),
    ).toEqual(['linh']);

    // Linh's statistics are private by default, even to a friend; the rest is for friends.
    // Linh's month has its tree (read once, as the app does on Home).
    await get(t, linh, '/me/trees/current');
    c['friendProfile'] = await get(t, mai, `/users/${linh.userId}/profile`);
    const friendProfile = c['friendProfile'] as Body;
    expect(friendProfile['statistics']).toBeNull();
    expect(friendProfile['currentTree']).not.toBeNull();
    c['friendForest'] = await get(t, mai, `/users/${linh.userId}/forest`);
    c['reacted'] = await send(
      mai,
      'put',
      `/users/${linh.userId}/reactions/sparkles?target=tree:2026-10`,
    );
    c['received'] = await get(t, linh, '/me/reactions');
    c['search'] = await get(t, mai, '/users/search?q=li');
    c['privacy'] = await get(t, mai, '/me/privacy');
    c['warnings'] = await get(t, mai, '/me/warnings');

    // Everyone joins the event; Mai starts a friend challenge with Linh.
    await send(mai, 'post', '/events/autumn-study/join');
    await send(linh, 'post', '/events/autumn-study/join');
    c['challengeCreated'] = await send(
      mai,
      'post',
      '/me/challenges',
      {
        templateId: 'steady-week-together',
        invite: [linh.userId],
      },
      201,
    );
    const challengeId = (c['challengeCreated'] as { id: string }).id;
    c['challengeAccepted'] = await send(linh, 'post', `/me/challenges/${challengeId}/accept`);

    // 2. A room: both ready, it starts on its own ten seconds later.
    c['roomCreated'] = await send(
      mai,
      'post',
      '/rooms',
      {
        name: 'Morning study',
        durationMinutes: 25,
        maxParticipants: 4,
        visibility: 'private',
      },
      201,
    );
    const room = c['roomCreated'] as { id: string; code: string };
    c['roomJoined'] = await send(linh, 'post', '/rooms/join', { code: room.code });
    await send(mai, 'put', `/rooms/${room.id}/ready`);
    c['roomCountdown'] = await send(linh, 'put', `/rooms/${room.id}/ready`);
    const startsAt = (c['roomCountdown'] as { startsAt: string }).startsAt;
    expect((c['roomCountdown'] as Body)['phase']).toBe('countdown');

    const before = async (user: User) =>
      (await get<{ tree: { progress: { growthMinutes: number } } }>(t, user, '/me/trees/current'))
        .tree.progress.growthMinutes;
    const maiBefore = await before(mai);
    const linhBefore = await before(linh);

    // Each focuses on their own topic and submits their own session.
    const start = Date.parse(startsAt);
    await t.setNow(new Date(start + 31 * MIN).toISOString());
    c['sessionInRoom'] = (await t.submit(mai, startsAt, 30, sid(501)).expect(201)).body;
    c['roomCompleted'] = await send(mai, 'post', `/rooms/${room.id}/complete`, {
      sessionId: sid(501),
    });
    await t.setNow(new Date(start + 51 * MIN).toISOString());
    await t.submit(linh, startsAt, 50, sid(502)).expect(201);
    await send(linh, 'post', `/rooms/${room.id}/complete`, { sessionId: sid(502) });

    // Each tree grew by its owner's minutes only.
    expect((await before(mai)) - maiBefore).toBe(30);
    expect((await before(linh)) - linhBefore).toBe(50);

    // 3. One session, everywhere: the event, the challenge, the Community Tree, the season.
    const results = (c['sessionInRoom'] as { events: Body[] }).events;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      eventId: 'autumn-study',
      community: { minutes: 30, totalMinutes: 30, reachedStages: [] },
    });
    const unlocked = (
      c['sessionInRoom'] as {
        progression: { newlyUnlockedCosmetics: { id: string }[] };
      }
    ).progression.newlyUnlockedCosmetics.map((x) => x.id);
    expect(unlocked).toEqual(['falling-leaves']);

    c['event'] = await get(t, mai, '/events/autumn-study');
    expect(
      (c['event'] as { missions: { id: string; value: number }[] }).missions.map((m) => [
        m.id,
        m.value,
      ]),
    ).toEqual([
      ['one-hour', 30],
      ['together', 1],
    ]);
    c['events'] = await get(t, mai, '/events');
    c['community'] = await get(t, mai, '/events/autumn-study/community-tree');
    expect(c['community']).toMatchObject({
      totalMinutes: 80,
      participants: 2,
      yourMinutes: 30,
      stage: 'seedling',
      celebrate: ['seedling'],
    });
    await send(
      mai,
      'post',
      '/events/autumn-study/community-tree/celebrations',
      { stages: ['seedling'] },
      204,
    );
    c['challenges'] = await get(t, mai, '/me/challenges');
    const current = (c['challenges'] as { current: { participants: { value: number }[] }[] })
      .current;
    expect(current[0]!.participants.map((p) => p.value)).toEqual([1, 1]);
    c['season'] = await get(t, mai, '/me/season');
    expect((c['season'] as { rewards: { owned: boolean }[] }).rewards[0]!.owned).toBe(true);
    c['home'] = await get(t, mai, '/me/home');
    expect((c['home'] as { event: Body }).event).toMatchObject({
      id: 'autumn-study',
      joined: true,
    });

    // Boards: friends (Mai and Linh), global without Kai for Mai, and the event's.
    c['boardFriends'] = await get(t, mai, '/leaderboards?scope=friends&period=weekly');
    c['boardGlobal'] = await get(t, mai, '/leaderboards?scope=global&period=weekly');
    const names = (board: unknown) =>
      (board as { rows: { person: { username: string } }[] }).rows
        .map((r) => r.person.username)
        .sort();
    expect(names(c['boardFriends'])).toEqual(['linh', 'mai']);
    expect(names(c['boardGlobal'])).toEqual(['linh', 'mai']);
    expect(names(await get(t, kai, '/leaderboards?scope=global&period=weekly'))).toEqual([
      'kai',
      'linh',
    ]);
    c['boardEvent'] = await get(t, mai, '/leaderboards?scope=event&eventId=autumn-study');
    c['blocks'] = await get(t, kai, '/me/blocks');

    // 4. The capture.
    const replace = new Map<string, string>([
      [mai.userId, '00000000-0000-4000-8000-0000000005a1'],
      [linh.userId, '00000000-0000-4000-8000-0000000005a2'],
      [kai.userId, '00000000-0000-4000-8000-0000000005a3'],
      [mai.topicId, '00000000-0000-4000-8000-0000000005b1'],
      [linh.topicId, '00000000-0000-4000-8000-0000000005b2'],
      [kai.topicId, '00000000-0000-4000-8000-0000000005b3'],
      [room.id, '00000000-0000-4000-8000-0000000005c1'],
      [room.code, 'ROOM01'],
      [challengeId, '00000000-0000-4000-8000-0000000005d1'],
      ...(c['received'] as { items: { id: string }[] }).items.map((item, i): [string, string] => [
        item.id,
        `00000000-0000-4000-8000-0000000005e${i}`,
      ]),
    ]);
    const captured = `${JSON.stringify(normalize(c, replace, new Map()), null, 2)}\n`;
    expect(captured).not.toMatch(/eyJ|password/);
    if (process.env['X5_UPDATE_CONTRACT'] === '1' || !existsSync(FILE)) {
      writeFileSync(FILE, captured);
    }
    expect(captured).toBe(readFileSync(FILE, 'utf8'));
  });
});
