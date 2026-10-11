import { randomUUID } from 'node:crypto';

import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A5.7 Community Tree (spec §12, docs/06 CommunityTree, docs/12 Phase 15): a shared tree that
 * grows from the event participants' focus minutes, reaches milestones once and keeps them, gives
 * every participant a shared reward, stays correct under concurrent contributions and after
 * account deletion, and never singles anyone out.
 */

const t = new ConsistencyHarness('2026-10-14T10:00:00.000Z');
type Auth = Record<string, string>;
interface User {
  userId: string;
  auth: Auth;
  topicId: string;
}
type Body = Record<string, unknown>;
interface Milestone {
  stage: string;
  thresholdMinutes: number;
  reached: boolean;
  reachedAt: string | null;
  rewards: { badge: Body | null; cosmetic: Body | null };
}
interface TreeDto {
  eventId: string;
  name: string;
  artworkId: string;
  stage: string | null;
  totalMinutes: number;
  participants: number;
  joined: boolean;
  yourMinutes: number | null;
  milestones: Milestone[];
  celebrate: string[];
}
interface Community {
  minutes: number;
  totalMinutes: number;
  reachedStages: string[];
}

/** An event from 15 to 22 October with a Community Tree: Seedling at 100 min, Bloom at 300. */
async function gardenEvent(over: { tree?: boolean } = {}) {
  await t.prisma.badgeDefinition.create({
    data: {
      id: 'shared-garden',
      category: 'event',
      rarity: 'rare',
      source: 'event',
      availability: 'limited',
      availableFrom: new Date('2026-10-15T00:00:00Z'),
      availableUntil: new Date('2026-10-29T00:00:00Z'),
      status: 'active',
      name: 'Shared Garden',
      description: 'Grew the Shared Garden together.',
      artworkId: 'shared-garden',
    },
  });
  await t.prisma.cosmeticDefinition.create({
    data: {
      id: 'garden-lights',
      type: 'decoration',
      rarity: 'rare',
      source: 'event',
      availability: 'limited',
      availableFrom: new Date('2026-10-15T00:00:00Z'),
      availableUntil: new Date('2026-10-29T00:00:00Z'),
      status: 'active',
      name: 'Garden Lights',
      description: 'Lights from the Shared Garden.',
      artworkId: 'garden-lights',
    },
  });
  await t.prisma.event.create({
    data: {
      id: 'shared-garden',
      name: 'Shared Garden',
      description: 'A week of growing one tree together.',
      artworkId: 'shared-garden',
      status: 'active',
      startsAt: new Date('2026-10-15T00:00:00Z'),
      endsAt: new Date('2026-10-22T00:00:00Z'),
      missions: {
        create: [
          {
            id: 'one-hour',
            measure: 'focus_minutes',
            target: 60,
            name: 'Focus 1 hour',
            description: 'One hour of focus.',
          },
        ],
      },
      ...(over.tree !== false && {
        communityTree: {
          create: {
            name: 'The Garden Oak',
            artworkId: 'garden-oak',
            milestones: {
              create: [
                { stage: 'seedling', thresholdMinutes: 100, cosmeticId: 'garden-lights' },
                { stage: 'bloom', thresholdMinutes: 300, badgeId: 'shared-garden' },
              ],
            },
          },
        },
      }),
    },
  });
}

async function person(name: string): Promise<User> {
  return t.signUp(`${name}@example.com`, 'UTC', '2026-09-01T00:00:00.000Z');
}
const join = (user: User) => t.http().post('/events/shared-garden/join').set(user.auth);
const tree = async (user: User) =>
  (await t.http().get('/events/shared-garden/community-tree').set(user.auth).expect(200))
    .body as TreeDto;
const total = async () =>
  Number(
    (
      await t.prisma.communityTree.findUniqueOrThrow({
        where: { eventId: 'shared-garden' },
      })
    ).totalMinutes,
  );
const ledgerSum = async () =>
  (
    await t.prisma.communityContribution.aggregate({
      where: { eventId: 'shared-garden' },
      _sum: { minutes: true },
    })
  )._sum.minutes ?? 0;
const communityOf = (body: unknown) =>
  (body as { events: { community: Community | null }[] }).events[0]?.community ?? null;

describe('Community Tree (A5.7, HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-14T10:00:00.000Z');
    await t.activateConfig();
  });

  describe('reading', () => {
    it('shows the shared total and milestones, and nothing about any one person', async () => {
      await gardenEvent();
      const ada = await person('ada');
      const seen = await tree(ada);
      expect(Object.keys(seen).sort()).toEqual(
        [
          'artworkId',
          'celebrate',
          'eventId',
          'joined',
          'milestones',
          'name',
          'participants',
          'stage',
          'totalMinutes',
          'yourMinutes',
        ].sort(),
      );
      expect(seen).toMatchObject({
        eventId: 'shared-garden',
        name: 'The Garden Oak',
        artworkId: 'garden-oak',
        stage: null,
        totalMinutes: 0,
        participants: 0,
        joined: false,
        yourMinutes: null,
        celebrate: [],
      });
      expect(seen.milestones.map((m) => [m.stage, m.thresholdMinutes, m.reached])).toEqual([
        ['seedling', 100, false],
        ['bloom', 300, false],
      ]);
      expect(seen.milestones[0]!.rewards.cosmetic).toMatchObject({ id: 'garden-lights' });
      expect(seen.milestones[1]!.rewards.badge).toMatchObject({ id: 'shared-garden' });

      const event = (await t.http().get('/events/shared-garden').set(ada.auth).expect(200))
        .body as Body;
      expect(event['communityTree']).toEqual({ stage: null, totalMinutes: 0 });
    });

    it('is 404 for an event without one, and for an event that is not shown', async () => {
      await gardenEvent({ tree: false });
      const ada = await person('ada');
      const missing = await t
        .http()
        .get('/events/shared-garden/community-tree')
        .set(ada.auth)
        .expect(404);
      expect(missing.body).toMatchObject({ code: 'community_tree_not_found' });
      const event = (await t.http().get('/events/shared-garden').set(ada.auth).expect(200))
        .body as Body;
      expect(event['communityTree']).toBeNull();
      await t.http().get('/events/nowhere/community-tree').set(ada.auth).expect(404);
    });
  });

  describe('contributions', () => {
    it("grow from participants' counted focus in the window, only", async () => {
      await gardenEvent();
      const ada = await person('ada');
      const bob = await person('bob');
      await join(ada).expect(200);
      await t.setNow('2026-10-15T14:00:00.000Z');
      const res = await t.submit(ada, '2026-10-15T08:00:00.000Z', 40.5).expect(201);
      // Whole minutes of focus, once.
      expect(communityOf(res.body)).toEqual({ minutes: 40, totalMinutes: 40, reachedStages: [] });
      // Bob has not joined: his focus does not grow the shared tree.
      await t.submit(bob, '2026-10-15T09:00:00.000Z', 50).expect(201);
      await t.focus(ada, [
        ['2026-10-14', 30],
        ['2026-10-16', 30, 'discarded'],
        ['2026-10-22', 30],
      ]);
      await t.setNow('2026-10-16T14:00:00.000Z');
      const second = await t.submit(ada, '2026-10-16T09:00:00.000Z', 20).expect(201);
      expect(communityOf(second.body)).toEqual({
        minutes: 20,
        totalMinutes: 60,
        reachedStages: [],
      });
      const seen = await tree(ada);
      expect(seen).toMatchObject({ totalMinutes: 60, participants: 1, yourMinutes: 60 });
      expect(await total()).toBe(60);
      expect(await ledgerSum()).toBe(60);
    });

    it('add the focus done in the window before joining, once, when joining', async () => {
      await gardenEvent();
      const ada = await person('ada');
      await t.focus(ada, [
        ['2026-10-14', 30],
        ['2026-10-15', 45],
        ['2026-10-16', 30, 'discarded'],
        ['2026-10-22', 30],
      ]);
      await t.setNow('2026-10-16T12:00:00.000Z');
      await join(ada).expect(200);
      await join(ada).expect(200);
      expect(await total()).toBe(45);
      expect((await tree(ada)).yourMinutes).toBe(45);
    });

    it('report the replay of a session unchanged, without adding again', async () => {
      await gardenEvent();
      const ada = await person('ada');
      await join(ada).expect(200);
      await t.setNow('2026-10-15T14:00:00.000Z');
      const id = randomUUID();
      const first = await t.submit(ada, '2026-10-15T08:00:00.000Z', 120, id).expect(201);
      expect(communityOf(first.body)).toEqual({
        minutes: 120,
        totalMinutes: 120,
        reachedStages: ['seedling'],
      });
      const replay = await t.submit(ada, '2026-10-15T08:00:00.000Z', 120, id).expect(200);
      expect((replay.body as Body)['events']).toEqual((first.body as Body)['events']);
      expect(await total()).toBe(120);
    });

    it('stay correct when many participants submit at once', async () => {
      await gardenEvent();
      const people: User[] = [];
      for (const name of ['ada', 'bob', 'cyd', 'dan', 'eve', 'fay', 'gus', 'hal']) {
        const user = await person(name);
        await join(user).expect(200);
        people.push(user);
      }
      await t.setNow('2026-10-15T14:00:00.000Z');
      const results = await Promise.all(
        people.map((user) => t.submit(user, '2026-10-15T08:00:00.000Z', 45)),
      );
      expect(results.map((r) => r.status)).toEqual(people.map(() => 201));
      expect(await total()).toBe(8 * 45);
      expect(await ledgerSum()).toBe(8 * 45);
      // Each milestone is reached by exactly one contribution, at the total that crossed it.
      const reached = results.flatMap((r) => communityOf(r.body)!.reachedStages);
      expect(reached.sort()).toEqual(['bloom', 'seedling']);
      const totals = results.map((r) => communityOf(r.body)!.totalMinutes).sort((a, b) => a - b);
      expect(totals).toEqual([45, 90, 135, 180, 225, 270, 315, 360]);
    });

    it('count a session submitted while its author joins exactly once', async () => {
      await gardenEvent();
      const people: User[] = [];
      for (const name of ['ada', 'bob', 'cyd', 'dan', 'eve', 'fay'])
        people.push(await person(name));
      await t.setNow('2026-10-15T14:00:00.000Z');
      await Promise.all(
        people.flatMap((user) => [join(user), t.submit(user, '2026-10-15T08:00:00.000Z', 50)]),
      );
      expect(await total()).toBe(6 * 50);
      expect(await ledgerSum()).toBe(6 * 50);
    });

    it('add a session the ledger missed with the next one', async () => {
      await gardenEvent();
      const ada = await person('ada');
      await join(ada).expect(200);
      // Submitted while the event was withdrawn: no contribution then.
      await t.prisma.event.update({ where: { id: 'shared-garden' }, data: { status: 'planned' } });
      await t.setNow('2026-10-15T14:00:00.000Z');
      await t.submit(ada, '2026-10-15T08:00:00.000Z', 30).expect(201);
      expect(await total()).toBe(0);
      await t.prisma.event.update({ where: { id: 'shared-garden' }, data: { status: 'active' } });
      const next = await t.submit(ada, '2026-10-15T09:00:00.000Z', 20).expect(201);
      expect(communityOf(next.body)).toEqual({ minutes: 50, totalMinutes: 50, reachedStages: [] });
    });
  });

  describe('milestones', () => {
    it('are reached once and kept, with their first time', async () => {
      await gardenEvent();
      const ada = await person('ada');
      await join(ada).expect(200);
      await t.setNow('2026-10-15T14:00:00.000Z');
      await t.submit(ada, '2026-10-15T08:00:00.000Z', 110).expect(201);
      await t.setNow('2026-10-16T14:00:00.000Z');
      const later = await t.submit(ada, '2026-10-16T08:00:00.000Z', 30).expect(201);
      expect(communityOf(later.body)!.reachedStages).toEqual([]);
      const seen = await tree(ada);
      expect(seen.stage).toBe('seedling');
      expect(seen.milestones.map((m) => [m.stage, m.reached, m.reachedAt])).toEqual([
        ['seedling', true, '2026-10-15T14:00:00.000Z'],
        ['bloom', false, null],
      ]);
      // The event's summary carries the same stage and total.
      const event = (await t.http().get('/events/shared-garden').set(ada.auth).expect(200))
        .body as Body;
      expect(event['communityTree']).toEqual({ stage: 'seedling', totalMinutes: 140 });
    });

    it('are kept after the account that reached them is deleted, which leaves the total', async () => {
      await gardenEvent();
      const ada = await person('ada');
      const bob = await person('bob');
      await join(ada).expect(200);
      await join(bob).expect(200);
      await t.setNow('2026-10-15T14:00:00.000Z');
      await t.submit(ada, '2026-10-15T08:00:00.000Z', 150).expect(201);
      await t.submit(bob, '2026-10-15T08:00:00.000Z', 20).expect(201);
      await t.prisma.user.delete({ where: { id: ada.userId } });

      const seen = await tree(bob);
      expect(seen).toMatchObject({
        stage: 'seedling',
        totalMinutes: 170,
        participants: 1,
        yourMinutes: 20,
      });
      expect(await ledgerSum()).toBe(170);
      // Anonymously: the ledger no longer names anyone deleted.
      expect(
        await t.prisma.communityContribution.count({
          where: { eventId: 'shared-garden', userId: null },
        }),
      ).toBe(1);
    });

    it('never lose progress, as the database enforces', async () => {
      await gardenEvent();
      const ada = await person('ada');
      await join(ada).expect(200);
      await t.setNow('2026-10-15T14:00:00.000Z');
      await t.submit(ada, '2026-10-15T08:00:00.000Z', 120).expect(201);
      await expect(
        t.prisma.communityTree.update({
          where: { eventId: 'shared-garden' },
          data: { totalMinutes: 10 },
        }),
      ).rejects.toThrow();
      await expect(
        t.prisma.communityContribution.deleteMany({ where: { eventId: 'shared-garden' } }),
      ).rejects.toThrow();
      await expect(
        t.prisma.communityContribution.updateMany({
          where: { eventId: 'shared-garden' },
          data: { minutes: 1 },
        }),
      ).rejects.toThrow();
      await expect(
        t.prisma.communityMilestone.update({
          where: { eventId_stage: { eventId: 'shared-garden', stage: 'seedling' } },
          data: { reachedAt: null },
        }),
      ).rejects.toThrow();
      await expect(
        t.prisma.communityMilestone.update({
          where: { eventId_stage: { eventId: 'shared-garden', stage: 'seedling' } },
          data: { reachedAt: new Date('2026-10-16T00:00:00Z') },
        }),
      ).rejects.toThrow();
      expect(await total()).toBe(120);
    });
  });

  describe('shared rewards', () => {
    it('go to every participant, whatever they contributed, once, and are celebrated once', async () => {
      await gardenEvent();
      const ada = await person('ada');
      const bob = await person('bob');
      const cyd = await person('cyd');
      await join(ada).expect(200);
      await join(bob).expect(200);
      await t.setNow('2026-10-15T14:00:00.000Z');
      await t.submit(ada, '2026-10-15T08:00:00.000Z', 120).expect(201);

      // Bob contributed nothing and still shares the reward; Cyd never joined.
      const bobs = await tree(bob);
      expect(bobs).toMatchObject({ yourMinutes: 0, celebrate: ['seedling'] });
      expect(await tree(bob)).toMatchObject({ celebrate: ['seedling'] });
      const cyds = await tree(cyd);
      expect(cyds).toMatchObject({ joined: false, celebrate: [] });
      const owners = await t.prisma.userCosmetic.findMany({
        where: { cosmeticId: 'garden-lights' },
        select: { userId: true },
        orderBy: { userId: 'asc' },
      });
      expect(owners.map((o) => o.userId).sort()).toEqual([ada.userId, bob.userId].sort());

      // The celebration is shown until seen, once; only the stages named are marked.
      await t
        .http()
        .post('/events/shared-garden/community-tree/celebrations')
        .set(bob.auth)
        .send({ stages: ['seedling'] })
        .expect(204);
      await t
        .http()
        .post('/events/shared-garden/community-tree/celebrations')
        .set(bob.auth)
        .send({ stages: ['seedling'] })
        .expect(204);
      expect((await tree(bob)).celebrate).toEqual([]);
      expect((await tree(ada)).celebrate).toEqual(['seedling']);
      await t
        .http()
        .post('/events/shared-garden/community-tree/celebrations')
        .set(ada.auth)
        .send({ stages: ['bloom'] })
        .expect(204);
      expect((await tree(ada)).celebrate).toEqual(['seedling']);
      await t
        .http()
        .post('/events/shared-garden/community-tree/celebrations')
        .set(ada.auth)
        .send({ stages: ['autumn'] })
        .expect(400);

      // Granted once, owned forever: after the event and the content window.
      await t.setNow('2026-11-05T12:00:00.000Z');
      await tree(bob);
      expect(await t.prisma.communityRewardGrant.count()).toBe(2);
      expect(await t.prisma.userCosmetic.count({ where: { cosmeticId: 'garden-lights' } })).toBe(2);
    });

    it('reach someone who joins after the milestone, while the event is on', async () => {
      await gardenEvent();
      const ada = await person('ada');
      const bob = await person('bob');
      await join(ada).expect(200);
      await t.setNow('2026-10-15T14:00:00.000Z');
      await t.submit(ada, '2026-10-15T08:00:00.000Z', 320).expect(201);
      await join(bob).expect(200);
      const seen = await tree(bob);
      expect(seen.stage).toBe('bloom');
      expect(seen.celebrate).toEqual(['seedling', 'bloom']);
      expect(
        await t.prisma.userBadge.count({
          where: { userId: bob.userId, badgeId: 'shared-garden' },
        }),
      ).toBe(1);
    });
  });

  describe('schema', () => {
    it('requires a shared reward and a positive threshold', async () => {
      await gardenEvent();
      const milestone = (over: Body) =>
        t.prisma.communityMilestone.create({
          data: {
            eventId: 'shared-garden',
            stage: 'final_form',
            thresholdMinutes: 1000,
            cosmeticId: 'garden-lights',
            ...over,
          },
        });
      await expect(milestone({ cosmeticId: null })).rejects.toThrow();
      await expect(milestone({ thresholdMinutes: 0 })).rejects.toThrow();
      await milestone({});
    });
  });
});
