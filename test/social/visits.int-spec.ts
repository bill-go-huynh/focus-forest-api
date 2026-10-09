import { randomUUID } from 'node:crypto';

import { ConsistencyHarness } from '../support/consistency-harness.js';

/** A5.2: privacy-filtered profiles, forest visits, and reactions. */

type Auth = Record<string, string>;
interface User {
  userId: string;
  auth: Auth;
  topicId: string;
}
type Body = Record<string, unknown>;

const NOTE = 'A private thought about Ada';
const ALL_HIDDEN = {
  profile: 'private',
  forest: 'private',
  statistics: 'private',
  badges: 'private',
  currentTree: 'private',
};
const NO_COUNTS = { fire: 0, sprout: 0, clap: 0, heart: 0, sparkles: 0 };

describe('profiles, visits, and reactions (A5.2, HTTP + PostgreSQL)', () => {
  const t = new ConsistencyHarness('2026-09-10T12:00:00.000Z');
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(async () => {
    t.reset();
    await t.setNow('2026-09-10T12:00:00.000Z');
    await t.activateConfig();
  });

  async function person(name: string, joinedAt = '2026-08-01T00:00:00.000Z'): Promise<User> {
    const user = await t.signUp(`${name}@example.com`, 'UTC', joinedAt);
    await t
      .http()
      .patch('/me/profile')
      .set(user.auth)
      .send({ username: name, displayName: name[0]!.toUpperCase() + name.slice(1) })
      .expect(200);
    return user;
  }
  const friends = async (a: User, b: User) => {
    await t.http().put(`/me/following/${b.userId}`).set(a.auth).expect(200);
    await t.http().put(`/me/following/${a.userId}`).set(b.auth).expect(200);
  };
  const privacy = (user: User, changes: Body) =>
    t.http().patch('/me/privacy').set(user.auth).send(changes).expect(200);
  const get = (viewer: User, path: string) => t.http().get(path).set(viewer.auth);
  const react = (viewer: User, owner: User, reaction: string, target: string) =>
    t.http().put(`/users/${owner.userId}/reactions/${reaction}`).query({ target }).set(viewer.auth);
  const unreact = (viewer: User, owner: User, reaction: string, target: string) =>
    t
      .http()
      .delete(`/users/${owner.userId}/reactions/${reaction}`)
      .query({ target })
      .set(viewer.auth);
  const summary = async (viewer: User, owner: User, target: string) =>
    (await get(viewer, `/users/${owner.userId}/reactions`).query({ target }).expect(200))
      .body as Body;

  /**
   * Ada: joined in August (resting), focused on 10 and 11 September with a highlighted note
   * (archived when she opens Home on 5 October), and once on 5 October (growing).
   */
  async function ada(): Promise<User> {
    const user = await person('ada');
    const first = randomUUID();
    await t.submit(user, '2026-09-10T08:00:00.000Z', 30, first).expect(201);
    await t
      .http()
      .patch(`/me/sessions/${first}/note`)
      .set(user.auth)
      .send({ note: NOTE })
      .expect(200);
    await t.http().put(`/me/sessions/${first}/note/highlight`).set(user.auth).expect(200);
    await t.setNow('2026-09-11T12:00:00.000Z');
    await t.submit(user, '2026-09-11T08:00:00.000Z', 30).expect(201);
    await t.setNow('2026-10-05T12:00:00.000Z');
    await t.http().get('/me/home').set(user.auth).expect(200);
    await t.submit(user, '2026-10-05T08:00:00.000Z', 30).expect(201);
    await t
      .http()
      .put('/me/badges/showcase')
      .set(user.auth)
      .send({ badgeIds: ['first-session'] })
      .expect(200);
    return user;
  }

  describe('the profile of another user', () => {
    it('shows each section only when its privacy allows (defaults: friends, statistics private)', async () => {
      const owner = await ada();
      const bob = await person('bob');
      const cyd = await person('cyd');
      await friends(owner, bob);
      await t.http().put(`/me/following/${owner.userId}`).set(cyd.auth).expect(200);

      const asFriend = (await get(bob, `/users/${owner.userId}/profile`).expect(200)).body as Body;
      expect(Object.keys(asFriend).sort()).toEqual([
        'badges',
        'currentTree',
        'forest',
        'profileFrame',
        'statistics',
        'user',
      ]);
      expect(asFriend['user']).toMatchObject({
        username: 'ada',
        relationship: { friends: true },
        visible: { profile: true, statistics: false },
      });
      expect(asFriend['currentTree']).toMatchObject({
        year: 2026,
        month: 10,
        status: 'growing',
        species: 'signature',
      });
      expect(asFriend['statistics']).toBeNull();
      expect(asFriend['badges']).toMatchObject({
        showcase: [{ id: 'first-session', earnedAt: '2026-09-10T12:00:00.000Z' }],
        recent: [{ id: 'first-session' }],
      });
      expect(asFriend['forest']).toEqual({ treeCount: 1 });
      expect(asFriend['profileFrame']).toBeNull();

      const asFollower = (await get(cyd, `/users/${owner.userId}/profile`).expect(200))
        .body as Body;
      expect(asFollower).toMatchObject({
        currentTree: null,
        statistics: null,
        badges: null,
        forest: null,
        profileFrame: null,
        user: { bio: null, joinDate: null },
      });
    });

    it('shows statistics when shared: totals and streaks, never topic names or notes', async () => {
      const owner = await ada();
      const cyd = await person('cyd');
      await privacy(owner, { statistics: 'public' });

      const body = (await get(cyd, `/users/${owner.userId}/profile`).expect(200)).body as Body;
      expect(body['statistics']).toEqual({
        focusedMinutes: 90,
        sessionCount: 3,
        currentStreak: 1,
        longestStreak: 2,
      });
      expect(JSON.stringify(body)).not.toContain('Reading');
      expect(JSON.stringify(body)).not.toContain(NOTE);
    });

    it('shows everything to the owner, nothing to a blocked user, and 404 for the unknown', async () => {
      const owner = await ada();
      await privacy(owner, ALL_HIDDEN);
      const self = (await get(owner, `/users/${owner.userId}/profile`).expect(200)).body as Body;
      expect(self['statistics']).not.toBeNull();
      expect(self['currentTree']).not.toBeNull();

      const bob = await person('bob');
      await t.http().put(`/me/blocks/${bob.userId}`).set(owner.auth).expect(204);
      await get(bob, `/users/${owner.userId}/profile`).expect(404);
      await get(owner, `/users/${bob.userId}/profile`).expect(404);
      await get(bob, '/users/0199c000-0000-7000-8000-000000000000/profile').expect(404);
    });

    it('lists the three most recent badges, newest first', async () => {
      const owner = await person('ada');
      // Seven days in a row: first session, 10 hours, 3- and 7-day streaks.
      await t.focus(
        owner,
        ['01', '02', '03', '04', '05', '06', '07'].map((d) => [`2026-09-${d}`, 100] as const),
      );
      await t.http().get('/me/badges').set(owner.auth).expect(200);
      await privacy(owner, { badges: 'public' });
      const cyd = await person('cyd');
      const body = (await get(cyd, `/users/${owner.userId}/profile`).expect(200)).body as {
        badges: { recent: { id: string }[]; showcase: unknown[] };
      };
      expect(body.badges.recent).toHaveLength(3);
      expect(body.badges.showcase).toEqual([]);
    });
  });

  describe('visiting a forest', () => {
    it('shows the timeline with the trees as the hero: no focus numbers, notes, or topics', async () => {
      const owner = await ada();
      const bob = await person('bob');
      await friends(owner, bob);

      const res = await get(bob, `/users/${owner.userId}/forest`).expect(200);
      const body = res.body as {
        items: Body[];
        nextCursor: string | null;
        summary: Body;
        progression: Body;
        equipment: Body;
      };
      expect(body.items.map((item) => [item['kind'], item['year'], item['month']])).toEqual([
        ['growing', 2026, 10],
        ['archived', 2026, 9],
        ['resting', 2026, 8],
      ]);
      expect(body.items[0]!['tree']).toMatchObject({ status: 'growing', month: 10 });
      expect(body.items[1]!['tree']).toMatchObject({ status: 'archived', month: 9 });
      for (const item of body.items) expect(item).not.toHaveProperty('focusedMilliseconds');
      expect(body.nextCursor).toBeNull();
      expect(body.summary).toEqual({ treeCount: 1 });
      expect(body.progression).toMatchObject({ level: 2 });
      expect(Object.keys(body.equipment).sort()).toEqual([
        'background',
        'decoration',
        'effect',
        'fauna',
        'weather',
      ]);
      expect(JSON.stringify(body)).not.toContain(NOTE);
      expect(JSON.stringify(body)).not.toContain('Reading');
    });

    it('pages newest first', async () => {
      const owner = await ada();
      await privacy(owner, { forest: 'public', currentTree: 'public' });
      const cyd = await person('cyd');
      const first = (
        await get(cyd, `/users/${owner.userId}/forest`).query({ limit: 2 }).expect(200)
      ).body as { items: Body[]; nextCursor: string };
      expect(first.items).toHaveLength(2);
      const second = (
        await get(cyd, `/users/${owner.userId}/forest`)
          .query({ limit: 2, cursor: first.nextCursor })
          .expect(200)
      ).body as { items: Body[]; nextCursor: string | null };
      expect(second.items.map((item) => item['month'])).toEqual([8]);
      expect(second.nextCursor).toBeNull();
      await get(cyd, `/users/${owner.userId}/forest`).query({ cursor: 'x' }).expect(400);
    });

    it('is refused when the forest is hidden, and keeps a hidden growing tree as a gap-free month', async () => {
      const owner = await ada();
      const cyd = await person('cyd');
      const hidden = await get(cyd, `/users/${owner.userId}/forest`).expect(403);
      expect(hidden.body).toMatchObject({ code: 'content_private' });

      await privacy(owner, { forest: 'public' });
      const body = (await get(cyd, `/users/${owner.userId}/forest`).expect(200)).body as {
        items: Body[];
      };
      expect(body.items[0]).toEqual({ kind: 'growing', year: 2026, month: 10, tree: null });
    });

    it('never closes, creates, or changes anything of the owner', async () => {
      const owner = await person('ada');
      await t.submit(owner, '2026-09-10T08:00:00.000Z', 30).expect(201);
      await privacy(owner, { forest: 'public', currentTree: 'public' });
      const cyd = await person('cyd');
      await t.setNow('2026-10-05T12:00:00.000Z');

      const body = (await get(cyd, `/users/${owner.userId}/forest`).expect(200)).body as {
        items: Body[];
      };
      // September waits for the owner's own next request to close.
      expect(body.items.map((item) => [item['kind'], item['month']])).toEqual([
        ['growing', 9],
        ['resting', 8],
      ]);
      await get(cyd, `/users/${owner.userId}/profile`).expect(200);
      await get(cyd, `/users/${owner.userId}/forest/2026/9`).expect(200);

      const trees = await t.prisma.monthlyTree.findMany({ where: { userId: owner.userId } });
      expect(trees.map((tree) => [tree.month, tree.status])).toEqual([[9, 'growing']]);
      expect(
        await t.prisma.monthAttributionContext.count({ where: { userId: owner.userId } }),
      ).toBe(1);
      expect(await t.prisma.userBadge.count({ where: { userId: owner.userId } })).toBe(1);
      expect(await t.prisma.forestAreaUnlock.count({ where: { userId: owner.userId } })).toBe(0);
    });

    it('is empty for someone with no month yet', async () => {
      const owner = await person('ada');
      await privacy(owner, { forest: 'public' });
      const cyd = await person('cyd');
      const body = (await get(cyd, `/users/${owner.userId}/forest`).expect(200)).body as Body;
      expect(body).toMatchObject({ items: [], nextCursor: null, summary: { treeCount: 0 } });
    });
  });

  describe('a visited month', () => {
    it('shows an archived tree with its badges, without stats unless shared, and never notes', async () => {
      const owner = await ada();
      const bob = await person('bob');
      await friends(owner, bob);

      const body = (await get(bob, `/users/${owner.userId}/forest/2026/9`).expect(200))
        .body as Body;
      expect(Object.keys(body).sort()).toEqual([
        'archivedAt',
        'badges',
        'kind',
        'month',
        'stats',
        'tree',
        'year',
      ]);
      expect(body).toMatchObject({ kind: 'archived', year: 2026, month: 9, stats: null });
      expect(body['badges']).toMatchObject([{ id: 'first-session' }]);
      expect(JSON.stringify(body)).not.toContain(NOTE);

      await privacy(owner, { statistics: 'friends', badges: 'private' });
      const shared = (await get(bob, `/users/${owner.userId}/forest/2026/9`).expect(200))
        .body as Body;
      expect(shared['badges']).toBeNull();
      expect(shared['stats']).toEqual({
        focusedMinutes: 60,
        sessionCount: 2,
        activeDays: 2,
        dailyGoalsMet: 0,
        weeklyGoalsMet: 0,
        longestStreak: 2,
      });
      expect(JSON.stringify(shared)).not.toContain('Reading');
    });

    it('shows a resting month, a growing tree by its own privacy, and 404 outside the forest', async () => {
      const owner = await ada();
      await privacy(owner, { forest: 'public' });
      const cyd = await person('cyd');
      expect((await get(cyd, `/users/${owner.userId}/forest/2026/8`).expect(200)).body).toEqual({
        kind: 'resting',
        year: 2026,
        month: 8,
      });
      expect((await get(cyd, `/users/${owner.userId}/forest/2026/10`).expect(200)).body).toEqual({
        kind: 'growing',
        year: 2026,
        month: 10,
        tree: null,
      });
      await get(cyd, `/users/${owner.userId}/forest/2026/7`).expect(404);
      await get(cyd, `/users/${owner.userId}/forest/2026/11`).expect(404);
      await get(cyd, `/users/${owner.userId}/forest/2026/13`).expect(400);
      await privacy(owner, { forest: 'friends' });
      await get(cyd, `/users/${owner.userId}/forest/2026/9`).expect(403);
    });
  });

  describe('reactions', () => {
    it('are added once per kind, counted, and removed', async () => {
      const owner = await ada();
      const bob = await person('bob');
      const eve = await person('eve');
      await friends(owner, bob);
      await friends(owner, eve);

      const added = await react(bob, owner, 'fire', 'tree:2026-09').expect(200);
      expect(added.body).toEqual({
        target: 'tree:2026-09',
        counts: { ...NO_COUNTS, fire: 1 },
        mine: ['fire'],
      });
      await react(bob, owner, 'fire', 'tree:2026-09').expect(200);
      await react(bob, owner, 'sparkles', 'tree:2026-09').expect(200);
      await react(eve, owner, 'fire', 'tree:2026-09').expect(200);
      expect(await summary(bob, owner, 'tree:2026-09')).toEqual({
        target: 'tree:2026-09',
        counts: { ...NO_COUNTS, fire: 2, sparkles: 1 },
        mine: ['fire', 'sparkles'],
      });
      expect(await summary(owner, owner, 'tree:2026-09')).toMatchObject({ mine: [] });

      const removed = await unreact(bob, owner, 'fire', 'tree:2026-09').expect(200);
      expect(removed.body).toMatchObject({ counts: { fire: 1, sparkles: 1 }, mine: ['sparkles'] });
      await unreact(bob, owner, 'fire', 'tree:2026-09').expect(200);
      expect(await t.prisma.reaction.count()).toBe(2);
    });

    it('reach a forest, an archived or growing tree, and an owned badge', async () => {
      const owner = await ada();
      const bob = await person('bob');
      await friends(owner, bob);
      await react(bob, owner, 'heart', 'forest').expect(200);
      await react(bob, owner, 'sprout', 'tree:2026-10').expect(200);
      await react(bob, owner, 'clap', 'badge:first-session').expect(200);
      expect(await t.prisma.reaction.count()).toBe(3);
    });

    it('refuse bad input, yourself, missing targets, hidden content, and blocks', async () => {
      const owner = await ada();
      const bob = await person('bob');
      const cyd = await person('cyd');
      await friends(owner, bob);

      await react(bob, owner, 'poop', 'forest').expect(400);
      await react(bob, owner, 'fire', 'note:1').expect(400);
      await t.http().put(`/users/${owner.userId}/reactions/fire`).set(bob.auth).expect(400);
      const self = await react(owner, owner, 'fire', 'forest').expect(422);
      expect(self.body).toMatchObject({ code: 'cannot_react_to_self' });
      for (const target of [
        'tree:2026-08',
        'tree:2026-11',
        'badge:focus-streak:100',
        'badge:nope',
      ]) {
        const missing = await react(bob, owner, 'fire', target).expect(404);
        expect(missing.body).toMatchObject({ code: 'reaction_target_not_found' });
      }
      const hidden = await react(cyd, owner, 'fire', 'forest').expect(403);
      expect(hidden.body).toMatchObject({ code: 'content_private' });
      await get(cyd, `/users/${owner.userId}/reactions`).query({ target: 'forest' }).expect(403);
      await privacy(owner, { forest: 'public' });
      await react(cyd, owner, 'fire', 'tree:2026-10').expect(403);
      await react(cyd, owner, 'fire', 'badge:first-session').expect(403);

      await t.http().put(`/me/blocks/${owner.userId}`).set(bob.auth).expect(204);
      await react(bob, owner, 'fire', 'forest').expect(404);
    });

    it('are listed for the owner, newest first, without suspended reactors', async () => {
      const owner = await ada();
      const bob = await person('bob');
      const eve = await person('eve');
      await friends(owner, bob);
      await friends(owner, eve);
      await react(bob, owner, 'fire', 'tree:2026-09').expect(200);
      t.clock.advance(1_000);
      await react(eve, owner, 'heart', 'forest').expect(200);
      t.clock.advance(1_000);
      await react(bob, owner, 'clap', 'badge:first-session').expect(200);

      const list = (await get(owner, '/me/reactions').expect(200)).body as {
        items: Body[];
        nextCursor: string | null;
      };
      expect(list.items.map((item) => [item['reaction'], item['target']])).toEqual([
        ['clap', 'badge:first-session'],
        ['heart', 'forest'],
        ['fire', 'tree:2026-09'],
      ]);
      expect(list.items[0]).toMatchObject({
        from: { id: bob.userId, username: 'bob', relationship: { friends: true } },
        createdAt: '2026-10-05T12:00:02.000Z',
      });
      expect(list.nextCursor).toBeNull();

      await t.prisma.user.update({ where: { id: bob.userId }, data: { status: 'suspended' } });
      const after = (await get(owner, '/me/reactions').expect(200)).body as { items: Body[] };
      expect(after.items.map((item) => item['reaction'])).toEqual(['heart']);
      expect(await summary(eve, owner, 'tree:2026-09')).toMatchObject({ counts: NO_COUNTS });
    });

    it('pages the list', async () => {
      const owner = await ada();
      await privacy(owner, { forest: 'public' });
      for (let i = 0; i < 26; i += 1) {
        const fan = await person(`fan${String(i).padStart(2, '0')}`);
        t.clock.advance(1_000);
        await react(fan, owner, 'fire', 'forest').expect(200);
        await react(fan, owner, 'heart', 'forest').expect(200);
      }
      const first = (await get(owner, '/me/reactions').expect(200)).body as {
        items: Body[];
        nextCursor: string;
      };
      expect(first.items).toHaveLength(50);
      const second = (
        await get(owner, '/me/reactions').query({ cursor: first.nextCursor }).expect(200)
      ).body as { items: Body[]; nextCursor: string | null };
      expect(second.items).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
      const ids = new Set([...first.items, ...second.items].map((item) => item['id']));
      expect(ids.size).toBe(52);
    });

    it('are removed by a block in both directions, also when both race', async () => {
      const owner = await ada();
      const bob = await person('bob');
      await friends(owner, bob);
      await react(bob, owner, 'fire', 'forest').expect(200);
      await react(owner, bob, 'fire', 'forest').expect(200);

      await t.http().put(`/me/blocks/${bob.userId}`).set(owner.auth).expect(204);
      expect(await t.prisma.reaction.count()).toBe(0);

      await t.http().delete(`/me/blocks/${bob.userId}`).set(owner.auth).expect(204);
      await privacy(owner, { forest: 'public' });
      for (let i = 0; i < 15; i += 1) {
        await Promise.all([
          react(bob, owner, 'fire', 'forest'),
          t.http().put(`/me/blocks/${bob.userId}`).set(owner.auth),
        ]);
        expect(await t.prisma.reaction.count()).toBe(0);
        await t.http().delete(`/me/blocks/${bob.userId}`).set(owner.auth).expect(204);
      }
    });

    it('are deleted with either user', async () => {
      const owner = await ada();
      const bob = await person('bob');
      await friends(owner, bob);
      await react(bob, owner, 'fire', 'forest').expect(200);
      await t.prisma.user.delete({ where: { id: bob.userId } });
      expect(await t.prisma.reaction.count()).toBe(0);
    });
  });
});
