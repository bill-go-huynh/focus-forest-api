import { ConsistencyHarness } from '../support/consistency-harness.js';

/** A5.1: usernames, search, follows, blocks, privacy settings, and the user card. */

type Auth = Record<string, string>;
interface User {
  userId: string;
  auth: Auth;
}
interface Relationship {
  following: boolean;
  followedBy: boolean;
  friends: boolean;
}
interface Summary {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  relationship: Relationship;
}
interface Card extends Summary {
  bio: string | null;
  joinDate: string | null;
  visible: Record<string, boolean>;
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const NONE: Relationship = { following: false, followedBy: false, friends: false };

describe('social graph and privacy (A5.1, HTTP + PostgreSQL)', () => {
  const NOW = '2026-10-08T10:00:00.000Z';
  const t = new ConsistencyHarness(NOW);
  beforeAll(() => t.start());
  afterAll(() => t.stop());
  beforeEach(() => t.clock.set(new Date(NOW)));

  async function person(name: string, username: string | null = name): Promise<User> {
    const user = await t.signUp(`${name}@example.com`);
    const changes: Record<string, string> = { displayName: name[0]!.toUpperCase() + name.slice(1) };
    if (username) changes['username'] = username;
    await t.http().patch('/me/profile').set(user.auth).send(changes).expect(200);
    return user;
  }

  const follow = (a: User, b: User) => t.http().put(`/me/following/${b.userId}`).set(a.auth);
  const unfollow = (a: User, b: User) => t.http().delete(`/me/following/${b.userId}`).set(a.auth);
  const block = (a: User, b: User) => t.http().put(`/me/blocks/${b.userId}`).set(a.auth);
  const unblock = (a: User, b: User) => t.http().delete(`/me/blocks/${b.userId}`).set(a.auth);
  const card = (a: User, b: User) => t.http().get(`/users/${b.userId}`).set(a.auth);
  const search = async (a: User, q: string) =>
    (
      (await t.http().get('/users/search').query({ q }).set(a.auth).expect(200))
        .body as Page<Summary>
    ).items;
  const following = async (a: User, query: Record<string, string> = {}) =>
    (await t.http().get('/me/following').query(query).set(a.auth).expect(200))
      .body as Page<Summary>;
  const followers = async (a: User, query: Record<string, string> = {}) =>
    (await t.http().get('/me/followers').query(query).set(a.auth).expect(200))
      .body as Page<Summary>;

  describe('usernames', () => {
    it('are null until chosen, then stored lowercase and shown in the profile', async () => {
      const ada = await t.signUp('ada@example.com');
      const before = await t.http().get('/me/profile').set(ada.auth).expect(200);
      expect((before.body as { username: unknown }).username).toBeNull();

      const res = await t
        .http()
        .patch('/me/profile')
        .set(ada.auth)
        .send({ username: '  Ada_L ' })
        .expect(200);
      expect((res.body as { username: string }).username).toBe('ada_l');
    });

    it('are unique ignoring case', async () => {
      await person('ada', 'ada_l');
      const grace = await t.signUp('grace@example.com');
      const res = await t
        .http()
        .patch('/me/profile')
        .set(grace.auth)
        .send({ username: 'ADA_L' })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'username_taken' });
    });

    it('refuses invalid and reserved names, and clearing', async () => {
      const ada = await t.signUp('ada@example.com');
      const invalid = await t
        .http()
        .patch('/me/profile')
        .set(ada.auth)
        .send({ username: 'ada-l' })
        .expect(400);
      expect(invalid.body).toMatchObject({ code: 'username_invalid' });
      const reserved = await t
        .http()
        .patch('/me/profile')
        .set(ada.auth)
        .send({ username: 'Admin' })
        .expect(422);
      expect(reserved.body).toMatchObject({ code: 'username_reserved' });
      await t.http().patch('/me/profile').set(ada.auth).send({ username: null }).expect(400);
    });

    it('can be changed, which frees the old name', async () => {
      const ada = await person('ada', 'ada_l');
      await t.http().patch('/me/profile').set(ada.auth).send({ username: 'countess' }).expect(200);
      await person('grace', 'ada_l');
    });

    it('can be set again to the same name', async () => {
      const ada = await person('ada', 'ada_l');
      await t.http().patch('/me/profile').set(ada.auth).send({ username: 'ADA_L' }).expect(200);
    });
  });

  describe('search', () => {
    it('finds usernames by prefix, exact match first, never the searcher', async () => {
      const ada = await person('ada');
      await person('adam');
      await person('adalyn');
      await person('grace');
      const bob = await person('bob');

      const found = await search(bob, 'Ada');
      expect(found.map((u) => u.username)).toEqual(['ada', 'adalyn', 'adam']);
      expect(found[0]).toEqual({
        id: ada.userId,
        username: 'ada',
        displayName: 'Ada',
        avatarUrl: null,
        relationship: NONE,
      });
      expect((await search(ada, 'ada')).map((u) => u.username)).toEqual(['adalyn', 'adam']);
    });

    it('hides blocked users both ways, suspended users, and users without a username', async () => {
      const bob = await person('bob');
      const ada = await person('ada');
      const adam = await person('adam');
      const adalyn = await person('adalyn');
      await t.signUp('adelaide@example.com');
      await block(bob, ada).expect(204);
      await block(adam, bob).expect(204);
      await t.prisma.user.update({ where: { id: adalyn.userId }, data: { status: 'suspended' } });

      expect(await search(bob, 'ad')).toEqual([]);
    });

    it('returns at most 20 and validates the query', async () => {
      const bob = await person('bob');
      for (let i = 0; i < 22; i += 1) await person(`user${String(i).padStart(2, '0')}`);
      expect(await search(bob, 'user')).toHaveLength(20);
      await t.http().get('/users/search').query({ q: '' }).set(bob.auth).expect(400);
      await t.http().get('/users/search').query({ q: 'a-b' }).set(bob.auth).expect(400);
      await t
        .http()
        .get('/users/search')
        .query({ q: 'x'.repeat(21) })
        .set(bob.auth)
        .expect(400);
      await t.http().get('/users/search').query({ q: 'ada' }).expect(401);
    });
  });

  describe('follows', () => {
    it('need no approval; a mutual follow makes friends', async () => {
      const ada = await person('ada');
      const bob = await person('bob');

      const first = await follow(ada, bob).expect(200);
      expect((first.body as Summary).relationship).toEqual({
        following: true,
        followedBy: false,
        friends: false,
      });
      const second = await follow(bob, ada).expect(200);
      expect((second.body as Summary).relationship).toEqual({
        following: true,
        followedBy: true,
        friends: true,
      });
      expect((await card(ada, bob).expect(200)).body).toMatchObject({
        relationship: { following: true, followedBy: true, friends: true },
      });
    });

    it('are idempotent', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      await follow(ada, bob).expect(200);
      await follow(ada, bob).expect(200);
      expect(await t.prisma.follow.count()).toBe(1);
      await unfollow(ada, bob).expect(204);
      await unfollow(ada, bob).expect(204);
      expect(await t.prisma.follow.count()).toBe(0);
    });

    it('refuse yourself, unknown users, and suspended users', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const self = await follow(ada, ada).expect(422);
      expect(self.body).toMatchObject({ code: 'cannot_follow_self' });
      await t
        .http()
        .put('/me/following/0199c000-0000-7000-8000-000000000000')
        .set(ada.auth)
        .expect(404);
      await t.http().put('/me/following/not-a-uuid').set(ada.auth).expect(400);
      await t.prisma.user.update({ where: { id: bob.userId }, data: { status: 'suspended' } });
      await follow(ada, bob).expect(404);
    });

    it('list following and followers newest first, with relationships and pages', async () => {
      const ada = await person('ada');
      const others: User[] = [];
      for (let i = 0; i < 52; i += 1) others.push(await person(`fan${String(i).padStart(2, '0')}`));
      for (const other of others) {
        t.clock.set(new Date(t.clock.now().getTime() + 1_000));
        await follow(other, ada).expect(200);
        await follow(ada, other).expect(200);
      }

      const page1 = await followers(ada);
      expect(page1.items).toHaveLength(50);
      expect(page1.items[0]!.username).toBe('fan51');
      expect(page1.items[0]!.relationship).toEqual({
        following: true,
        followedBy: true,
        friends: true,
      });
      const page2 = await followers(ada, { cursor: page1.nextCursor! });
      expect(page2.items.map((u) => u.username)).toEqual(['fan01', 'fan00']);
      expect(page2.nextCursor).toBeNull();
      expect((await following(ada)).items[0]!.username).toBe('fan51');
      await t.http().get('/me/followers').query({ cursor: 'nope' }).set(ada.auth).expect(400);
    });

    it('hide suspended users from the lists without deleting the follow', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      await follow(bob, ada).expect(200);
      await t.prisma.user.update({ where: { id: bob.userId }, data: { status: 'suspended' } });
      expect((await followers(ada)).items).toEqual([]);
      expect(await t.prisma.follow.count()).toBe(1);
    });

    it('can remove a follower', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      await follow(bob, ada).expect(200);
      await t.http().delete(`/me/followers/${bob.userId}`).set(ada.auth).expect(204);
      await t.http().delete(`/me/followers/${bob.userId}`).set(ada.auth).expect(204);
      expect((await followers(ada)).items).toEqual([]);
      expect((await card(bob, ada).expect(200)).body).toMatchObject({ relationship: NONE });
    });
  });

  describe('blocks', () => {
    it('remove follows both ways and override everything', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      await follow(ada, bob).expect(200);
      await follow(bob, ada).expect(200);

      await block(ada, bob).expect(204);

      expect(await t.prisma.follow.count()).toBe(0);
      // The blocked user cannot tell a block from a missing account.
      const missing = await t
        .http()
        .put('/me/following/0199c000-0000-7000-8000-000000000000')
        .set(bob.auth)
        .expect(404);
      const blocked = await follow(bob, ada).expect(404);
      expect(blocked.body).toEqual(missing.body);
      await card(bob, ada).expect(404);
      // The blocker cannot follow either, until they unblock.
      await follow(ada, bob).expect(404);
      await card(ada, bob).expect(404);
    });

    it('are idempotent; unblocking restores no follow', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      await follow(ada, bob).expect(200);
      await block(ada, bob).expect(204);
      await block(ada, bob).expect(204);
      expect(await t.prisma.block.count()).toBe(1);
      await unblock(ada, bob).expect(204);
      await unblock(ada, bob).expect(204);
      expect(await t.prisma.follow.count()).toBe(0);
      await follow(ada, bob).expect(200);
    });

    it('list the blocked users, suspended ones included', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      await block(ada, bob).expect(204);
      await t.prisma.user.update({ where: { id: bob.userId }, data: { status: 'suspended' } });
      const res = await t.http().get('/me/blocks').set(ada.auth).expect(200);
      expect(res.body).toEqual({
        items: [
          {
            id: bob.userId,
            username: 'bob',
            displayName: 'Bob',
            avatarUrl: null,
            blockedAt: '2026-10-08T10:00:00.000Z',
          },
        ],
        nextCursor: null,
      });
    });

    it('refuse yourself and unknown users', async () => {
      const ada = await person('ada');
      const self = await block(ada, ada).expect(422);
      expect(self.body).toMatchObject({ code: 'cannot_block_self' });
      await t
        .http()
        .put('/me/blocks/0199c000-0000-7000-8000-000000000000')
        .set(ada.auth)
        .expect(404);
    });

    it('never leave a follow next to a block when both race', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      for (let i = 0; i < 15; i += 1) {
        await Promise.all([follow(bob, ada), block(ada, bob)]);
        const follows = await t.prisma.follow.count();
        const blocks = await t.prisma.block.count();
        expect({ follows, blocks }).toEqual({ follows: 0, blocks: 1 });
        await unblock(ada, bob).expect(204);
      }
    });
  });

  describe('privacy settings', () => {
    it('start from the defaults and change per category', async () => {
      const ada = await person('ada');
      const defaults = await t.http().get('/me/privacy').set(ada.auth).expect(200);
      expect(defaults.body).toEqual({
        profile: 'friends',
        forest: 'friends',
        statistics: 'private',
        badges: 'friends',
        currentTree: 'friends',
      });
      const changed = await t
        .http()
        .patch('/me/privacy')
        .set(ada.auth)
        .send({ forest: 'public', statistics: 'friends' })
        .expect(200);
      expect(changed.body).toEqual({
        profile: 'friends',
        forest: 'public',
        statistics: 'friends',
        badges: 'friends',
        currentTree: 'friends',
      });
      expect((await t.http().get('/me/privacy').set(ada.auth).expect(200)).body).toEqual(
        changed.body,
      );
    });

    it('refuse unknown levels and categories', async () => {
      const ada = await person('ada');
      await t.http().patch('/me/privacy').set(ada.auth).send({ forest: 'everyone' }).expect(400);
      await t.http().patch('/me/privacy').set(ada.auth).send({ notes: 'public' }).expect(400);
      await t.http().patch('/me/privacy').set(ada.auth).send({}).expect(400);
    });
  });

  describe('the user card', () => {
    it('shows identity to anyone, the profile by privacy, and what else is visible', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      const cy = await person('cyd');
      await t.http().patch('/me/profile').set(ada.auth).send({ bio: 'Engines.' }).expect(200);
      await t
        .http()
        .patch('/me/privacy')
        .set(ada.auth)
        .send({ forest: 'public', badges: 'private' })
        .expect(200);
      await follow(ada, bob).expect(200);
      await follow(bob, ada).expect(200);
      await follow(cy, ada).expect(200);

      const asFriend = (await card(bob, ada).expect(200)).body as Card;
      expect(asFriend).toEqual({
        id: ada.userId,
        username: 'ada',
        displayName: 'Ada',
        avatarUrl: null,
        bio: 'Engines.',
        joinDate: '2026-01-01T00:00:00.000Z',
        relationship: { following: true, followedBy: true, friends: true },
        visible: {
          profile: true,
          forest: true,
          statistics: false,
          badges: false,
          currentTree: true,
        },
      });

      const asFollower = (await card(cy, ada).expect(200)).body as Card;
      expect(asFollower).toMatchObject({
        username: 'ada',
        bio: null,
        joinDate: null,
        relationship: { following: true, followedBy: false, friends: false },
        visible: {
          profile: false,
          forest: true,
          statistics: false,
          badges: false,
          currentTree: false,
        },
      });

      const own = (await card(ada, ada).expect(200)).body as Card;
      expect(own.visible).toEqual({
        profile: true,
        forest: true,
        statistics: true,
        badges: true,
        currentTree: true,
      });
      expect(own.relationship).toEqual(NONE);
    });

    it('hides suspended and unknown users as not found', async () => {
      const ada = await person('ada');
      const bob = await person('bob');
      await t.prisma.user.update({ where: { id: bob.userId }, data: { status: 'suspended' } });
      await card(ada, bob).expect(404);
      await t.http().get('/users/0199c000-0000-7000-8000-000000000000').set(ada.auth).expect(404);
    });
  });

  it('deletes follows, blocks, and privacy with the user', async () => {
    const ada = await person('ada');
    const bob = await person('bob');
    const cy = await person('cyd');
    await follow(ada, bob).expect(200);
    await follow(bob, ada).expect(200);
    await block(ada, cy).expect(204);
    await t.http().patch('/me/privacy').set(ada.auth).send({ forest: 'public' }).expect(200);

    await t.prisma.user.delete({ where: { id: ada.userId } });

    expect(await t.prisma.follow.count()).toBe(0);
    expect(await t.prisma.block.count()).toBe(0);
    expect(await t.prisma.privacySettings.count()).toBe(0);
  });
});
