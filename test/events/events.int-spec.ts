import { randomUUID } from 'node:crypto';

import { Prisma } from '../../src/generated/prisma/client.js';
import { MonthlyTreesService } from '../../src/trees/monthly-trees.service.js';
import { ConsistencyHarness } from '../support/consistency-harness.js';

/**
 * A5.6 Events and missions (spec §11, docs/02 Events, docs/06 Event): time-bound invitations whose
 * missions count normal focus, with permanent rewards and an event trait on that month's tree.
 */

const t = new ConsistencyHarness('2026-10-14T10:00:00.000Z');
type Auth = Record<string, string>;
interface User {
  userId: string;
  auth: Auth;
  topicId: string;
}
type Body = Record<string, unknown>;
interface Mission {
  id: string;
  measure: string;
  target: number;
  value: number | null;
  completed: boolean;
}
interface EventDto {
  id: string;
  name: string;
  phase: string;
  startsAt: string;
  endsAt: string;
  joined: boolean;
  missions: Mission[];
  milestones: { id: string; requiredMissions: number; reached: boolean; rewards: Body }[];
}

/** An event from 15 to 22 October with three missions and two milestones. */
async function autumnEvent(
  over: { status?: 'active' | 'planned'; entryMinSessions?: number } = {},
) {
  await t.prisma.badgeDefinition.create({
    data: {
      id: 'autumn-study',
      category: 'event',
      rarity: 'rare',
      source: 'event',
      availability: 'limited',
      availableFrom: new Date('2026-10-15T00:00:00Z'),
      availableUntil: new Date('2026-10-29T00:00:00Z'),
      status: 'active',
      name: 'Autumn Study',
      description: 'Took part in the Autumn Study event.',
      artworkId: 'autumn-study',
    },
  });
  await t.prisma.cosmeticDefinition.create({
    data: {
      id: 'maple-lanterns',
      type: 'decoration',
      rarity: 'rare',
      source: 'event',
      availability: 'limited',
      availableFrom: new Date('2026-10-15T00:00:00Z'),
      availableUntil: new Date('2026-10-29T00:00:00Z'),
      status: 'active',
      name: 'Maple Lanterns',
      description: 'Lanterns from the Autumn Study event.',
      artworkId: 'maple-lanterns',
    },
  });
  await t.prisma.event.create({
    data: {
      id: 'autumn-study',
      name: 'Autumn Study',
      description: 'A week of steady autumn focus.',
      artworkId: 'autumn-study',
      status: over.status ?? 'active',
      startsAt: new Date('2026-10-15T00:00:00Z'),
      endsAt: new Date('2026-10-22T00:00:00Z'),
      entryMinSessions: over.entryMinSessions ?? 0,
      missions: {
        create: [
          {
            id: 'five-hours',
            measure: 'focus_minutes',
            target: 300,
            name: 'Focus 5 hours',
            description: 'Five hours of focus.',
            sortOrder: 1,
          },
          {
            id: 'three-days',
            measure: 'active_days',
            target: 3,
            name: 'Focus on 3 days',
            description: 'Three different days.',
            sortOrder: 2,
          },
          {
            id: 'together',
            measure: 'focus_together_sessions',
            target: 1,
            name: 'Focus together once',
            description: 'One Focus Together session.',
            sortOrder: 3,
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
            sortOrder: 1,
          },
          {
            id: 'full-autumn',
            requiredMissions: 2,
            badgeId: 'autumn-study',
            name: 'Full autumn',
            sortOrder: 2,
          },
        ],
      },
    },
  });
}

async function person(name: string): Promise<User> {
  return t.signUp(`${name}@example.com`, 'UTC', '2026-09-01T00:00:00.000Z');
}
const join = (user: User) => t.http().post('/events/autumn-study/join').set(user.auth);
const event = async (user: User) =>
  (await t.http().get('/events/autumn-study').set(user.auth).expect(200)).body as EventDto;

describe('Events (A5.6, HTTP + PostgreSQL)', () => {
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-10-14T10:00:00.000Z');
    await t.activateConfig();
  });

  describe('listing and joining', () => {
    it('lists live and upcoming events, never planned or ended ones', async () => {
      await autumnEvent();
      const ada = await person('ada');
      const upcoming = (await t.http().get('/events').set(ada.auth).expect(200)).body as {
        items: EventDto[];
      };
      expect(upcoming.items.map((e) => [e.id, e.phase, e.joined])).toEqual([
        ['autumn-study', 'upcoming', false],
      ]);
      expect(upcoming.items[0]!.missions.map((m) => [m.id, m.target, m.value])).toEqual([
        ['five-hours', 300, null],
        ['three-days', 3, null],
        ['together', 1, null],
      ]);
      await t.setNow('2026-10-22T00:00:00.000Z');
      expect(
        ((await t.http().get('/events').set(ada.auth).expect(200)).body as Body)['items'],
      ).toEqual([]);
    });

    it('hides planned events', async () => {
      await autumnEvent({ status: 'planned' });
      const ada = await person('ada');
      expect(
        ((await t.http().get('/events').set(ada.auth).expect(200)).body as Body)['items'],
      ).toEqual([]);
      await t.http().get('/events/autumn-study').set(ada.auth).expect(404);
      await join(ada).expect(404);
    });

    it('joins once, before or during the event, never after it', async () => {
      await autumnEvent();
      const ada = await person('ada');
      expect(((await join(ada).expect(200)).body as EventDto).joined).toBe(true);
      await join(ada).expect(200);
      expect(await t.prisma.eventParticipation.count()).toBe(1);
      const bob = await person('bob');
      await t.setNow('2026-10-22T00:00:00.000Z');
      const late = await join(bob).expect(409);
      expect(late.body).toMatchObject({ code: 'event_ended' });
    });

    it('applies the entry condition', async () => {
      await autumnEvent({ entryMinSessions: 2 });
      const ada = await person('ada');
      const refused = await join(ada).expect(422);
      expect(refused.body).toMatchObject({ code: 'event_entry_not_met' });
      await t.focus(ada, [
        ['2026-10-10', 20],
        ['2026-10-11', 20],
      ]);
      await join(ada).expect(200);
    });
  });

  describe('missions', () => {
    it('count the normal counted focus that started inside the event window, only', async () => {
      await autumnEvent();
      const ada = await person('ada');
      await join(ada).expect(200);
      await t.focus(ada, [
        ['2026-10-14', 200],
        ['2026-10-15', 60],
        ['2026-10-16', 60, 'discarded'],
        ['2026-10-17', 120],
        ['2026-10-22', 300],
      ]);
      await t.setNow('2026-10-23T10:00:00.000Z');
      const seen = await event(ada);
      expect(seen.missions.map((m) => [m.id, m.value, m.completed])).toEqual([
        ['five-hours', 180, false],
        ['three-days', 2, false],
        ['together', 0, false],
      ]);
    });

    it('are shown only once joined', async () => {
      await autumnEvent();
      const ada = await person('ada');
      await t.focus(ada, [['2026-10-15', 60]]);
      await t.setNow('2026-10-15T12:00:00.000Z');
      expect((await event(ada)).missions.every((m) => m.value === null)).toBe(true);
    });
  });

  describe('a session during the event', () => {
    it('reports mission progress and the milestones it reached, after focus, once', async () => {
      await autumnEvent();
      const ada = await person('ada');
      await join(ada).expect(200);
      await t.setNow('2026-10-15T14:00:00.000Z');
      const id = randomUUID();
      const res = await t.submit(ada, '2026-10-15T08:00:00.000Z', 300, id).expect(201);
      const body = res.body as { events: Body[] };
      expect(body.events).toEqual([
        {
          eventId: 'autumn-study',
          missions: [
            { id: 'five-hours', value: 300, target: 300, completed: true },
            { id: 'three-days', value: 1, target: 3, completed: false },
            { id: 'together', value: 0, target: 1, completed: false },
          ],
          newlyCompletedMissionIds: ['five-hours'],
          newlyReachedMilestoneIds: ['first-leaf'],
          // A5.7: this event has no Community Tree.
          community: null,
        },
      ]);
      // The replay answers the same, stored with the session.
      const replay = await t.submit(ada, '2026-10-15T08:00:00.000Z', 300, id).expect(200);
      expect((replay.body as { events: unknown }).events).toEqual(body.events);
      // A later session reports progress, but nothing newly completed or reached.
      await t.setNow('2026-10-16T14:00:00.000Z');
      const later = await t.submit(ada, '2026-10-16T08:00:00.000Z', 30).expect(201);
      expect((later.body as { events: Body[] }).events[0]).toMatchObject({
        newlyCompletedMissionIds: [],
        newlyReachedMilestoneIds: [],
      });

      // The milestone's rewards: the cosmetic, owned forever, and the trait on this month's tree.
      expect(
        await t.prisma.userCosmetic.findMany({
          where: { userId: ada.userId },
          select: { cosmeticId: true },
        }),
      ).toEqual([{ cosmeticId: 'maple-lanterns' }]);
      const tree = (await t.http().get('/me/trees/current').set(ada.auth).expect(200)).body as {
        tree: { traits: { id: string }[] };
      };
      expect(tree.tree.traits.map((trait) => trait.id)).toContain('event:autumn-study');
    });

    it('reports nothing for someone who has not joined', async () => {
      await autumnEvent();
      const ada = await person('ada');
      await t.setNow('2026-10-15T14:00:00.000Z');
      const res = await t.submit(ada, '2026-10-15T08:00:00.000Z', 300).expect(201);
      expect((res.body as { events: unknown }).events).toEqual([]);
      expect(await t.prisma.userCosmetic.count({ where: { cosmeticId: 'maple-lanterns' } })).toBe(
        0,
      );
    });

    it('ignores an event withdrawn to planned, even for someone who joined', async () => {
      await autumnEvent();
      const ada = await person('ada');
      await join(ada).expect(200);
      await t.prisma.event.update({ where: { id: 'autumn-study' }, data: { status: 'planned' } });
      await t.setNow('2026-10-15T14:00:00.000Z');
      const res = await t.submit(ada, '2026-10-15T08:00:00.000Z', 300).expect(201);
      expect((res.body as { events: unknown }).events).toEqual([]);
    });

    it('answers null for sessions stored before A5.6', async () => {
      const ada = await person('ada');
      await t.setNow('2026-10-15T12:00:00.000Z');
      const id = randomUUID();
      await t.submit(ada, '2026-10-15T08:00:00.000Z', 30, id).expect(201);
      await t.prisma.focusSession.update({
        where: { userId_id: { userId: ada.userId, id } },
        data: { eventResult: Prisma.DbNull },
      });
      const replay = await t.submit(ada, '2026-10-15T08:00:00.000Z', 30, id).expect(200);
      expect((replay.body as { events: unknown }).events).toBeNull();
    });
  });

  describe('rewards', () => {
    it('are granted on joining late, from focus already done, and kept after the event', async () => {
      await autumnEvent();
      const ada = await person('ada');
      await t.focus(ada, [
        ['2026-10-15', 200],
        ['2026-10-16', 120],
        ['2026-10-17', 30],
      ]);
      await t.setNow('2026-10-18T12:00:00.000Z');
      await t.http().get('/me/trees/current').set(ada.auth).expect(200);
      await join(ada).expect(200);
      const seen = await event(ada);
      expect(seen.milestones.map((m) => [m.id, m.reached])).toEqual([
        ['first-leaf', true],
        ['full-autumn', true],
      ]);
      const owned = await t.prisma.userBadge.findMany({
        where: { userId: ada.userId, badgeId: 'autumn-study' },
      });
      expect(owned).toHaveLength(1);
      const traits = await t.prisma.monthlyTreeTrait.findMany({
        where: { userId: ada.userId, traitId: { startsWith: 'event:' } },
      });
      expect(traits.map((trait) => [trait.month, trait.traitId])).toEqual([
        [10, 'event:autumn-study'],
      ]);

      // After the event, and after the badge stopped being acquirable: still owned.
      await t.setNow('2026-11-05T12:00:00.000Z');
      const collection = (await t.http().get('/me/collection').set(ada.auth).expect(200)).body as {
        sections: { kind: string; items: { id: string; owned: boolean }[] }[];
      };
      const badges = collection.sections.find((s) => s.kind === 'badges')!;
      expect(badges.items.find((item) => item.id === 'autumn-study')).toMatchObject({
        owned: true,
      });
    });

    it('never grants a reward twice, also when reads race', async () => {
      await autumnEvent();
      const ada = await person('ada');
      await t.focus(ada, [['2026-10-15', 300]]);
      await t.setNow('2026-10-16T12:00:00.000Z');
      await t.http().get('/me/trees/current').set(ada.auth).expect(200);
      await join(ada).expect(200);
      await Promise.all(
        Array.from({ length: 4 }, () => t.http().get('/events/autumn-study').set(ada.auth)),
      );
      expect(await t.prisma.eventMilestoneGrant.count()).toBe(1);
      expect(
        await t.prisma.monthlyTreeTrait.count({ where: { traitId: 'event:autumn-study' } }),
      ).toBe(1);
    });

    it('keeps the event trait with the archived month', async () => {
      await autumnEvent();
      const ada = await person('ada');
      await join(ada).expect(200);
      await t.setNow('2026-10-15T14:00:00.000Z');
      await t.submit(ada, '2026-10-15T08:00:00.000Z', 300).expect(201);
      await t.setNow('2026-11-02T12:00:00.000Z');
      await t.http().get('/me/home').set(ada.auth).expect(200);
      const archived = (await t.http().get('/me/trees/2026/10').set(ada.auth).expect(200)).body as {
        tree: { traits: { id: string }[] };
      };
      expect(archived.tree.traits.map((trait) => trait.id)).toContain('event:autumn-study');
    });

    it('never places a trait on an archived tree', async () => {
      const ada = await person('ada');
      await t.setNow('2026-10-15T14:00:00.000Z');
      await t.submit(ada, '2026-10-15T08:00:00.000Z', 30).expect(201);
      await t.setNow('2026-11-02T12:00:00.000Z');
      await t.http().get('/me/home').set(ada.auth).expect(200);
      const trees = t.app.get(MonthlyTreesService);
      expect(
        await trees.placeTrait(t.prisma, ada.userId, 'event:x', new Date(), {
          year: 2026,
          month: 10,
        }),
      ).toBeNull();
      expect(await t.prisma.monthlyTreeTrait.count({ where: { traitId: 'event:x' } })).toBe(0);
    });

    it('hides event content not owned from the collection', async () => {
      await autumnEvent();
      const ada = await person('ada');
      await t.setNow('2026-10-16T12:00:00.000Z');
      const collection = (await t.http().get('/me/collection').set(ada.auth).expect(200)).body as {
        sections: { items: { id: string }[] }[];
      };
      const ids = collection.sections.flatMap((s) => s.items.map((item) => item.id));
      expect(ids).not.toContain('autumn-study');
      expect(ids).not.toContain('maple-lanterns');
    });
  });

  describe('Home', () => {
    it('shows at most one quiet event card: joined first, else one to join', async () => {
      await autumnEvent();
      const ada = await person('ada');
      const home = async () =>
        ((await t.http().get('/me/home').set(ada.auth).expect(200)).body as { event: unknown })
          .event;
      expect(await home()).toEqual({
        id: 'autumn-study',
        name: 'Autumn Study',
        artworkId: 'autumn-study',
        phase: 'upcoming',
        startsAt: '2026-10-15T00:00:00.000Z',
        endsAt: '2026-10-22T00:00:00.000Z',
        joined: false,
        missionsCompleted: null,
        missionsTotal: 3,
      });
      // An earlier event not joined never replaces the joined one.
      await t.prisma.event.create({
        data: {
          id: 'early-bird-week',
          name: 'Early Bird Week',
          description: 'x',
          artworkId: 'early-bird-week',
          status: 'active',
          startsAt: new Date('2026-10-14T00:00:00Z'),
          endsAt: new Date('2026-10-30T00:00:00Z'),
          missions: {
            create: [{ id: 'one', measure: 'sessions', target: 1, name: 'x', description: 'x' }],
          },
        },
      });
      expect(await home()).toMatchObject({ id: 'early-bird-week', joined: false });
      await join(ada).expect(200);
      await t.setNow('2026-10-15T14:00:00.000Z');
      await t.submit(ada, '2026-10-15T08:00:00.000Z', 300).expect(201);
      expect(await home()).toMatchObject({
        id: 'autumn-study',
        phase: 'live',
        joined: true,
        missionsCompleted: 1,
      });
      // Once the joined event ends, the other live one shows; after both end, none.
      await t.setNow('2026-10-22T00:00:00.000Z');
      expect(await home()).toMatchObject({ id: 'early-bird-week', joined: false });
      await t.setNow('2026-10-30T00:00:00.000Z');
      expect(await home()).toBeNull();
    });
  });
});
