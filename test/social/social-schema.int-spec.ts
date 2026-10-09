import { ConsistencyHarness } from '../support/consistency-harness.js';

/** A5.1: the database keeps the social graph sound even without the service. */
describe('social schema (A5.1, PostgreSQL)', () => {
  const t = new ConsistencyHarness('2026-10-08T10:00:00.000Z');
  beforeAll(() => t.start());
  afterAll(() => t.stop());

  const users = async () => {
    const ada = await t.signUp('ada@example.com');
    const bob = await t.signUp('bob@example.com');
    return { ada: ada.userId, bob: bob.userId };
  };

  it('refuses usernames outside the pattern, and duplicates', async () => {
    const { ada, bob } = await users();
    await expect(
      t.prisma.user.update({ where: { id: ada }, data: { username: 'Ada' } }),
    ).rejects.toThrow();
    await expect(
      t.prisma.user.update({ where: { id: ada }, data: { username: 'ab' } }),
    ).rejects.toThrow();
    await t.prisma.user.update({ where: { id: ada }, data: { username: 'ada' } });
    await expect(
      t.prisma.user.update({ where: { id: bob }, data: { username: 'ada' } }),
    ).rejects.toThrow();
  });

  it('refuses following or blocking yourself', async () => {
    const { ada } = await users();
    await expect(
      t.prisma.follow.create({ data: { followerId: ada, followeeId: ada, createdAt: new Date() } }),
    ).rejects.toThrow();
    await expect(
      t.prisma.block.create({ data: { blockerId: ada, blockedId: ada, createdAt: new Date() } }),
    ).rejects.toThrow();
  });

  it('refuses a follow while either user blocks the other', async () => {
    const { ada, bob } = await users();
    await t.prisma.block.create({
      data: { blockerId: bob, blockedId: ada, createdAt: new Date() },
    });
    await expect(
      t.prisma.follow.create({ data: { followerId: ada, followeeId: bob, createdAt: new Date() } }),
    ).rejects.toThrow(/blocked/);
    await expect(
      t.prisma.follow.create({ data: { followerId: bob, followeeId: ada, createdAt: new Date() } }),
    ).rejects.toThrow(/blocked/);
  });

  it('refuses unknown privacy levels', async () => {
    const { ada } = await users();
    const insert = (forest: string) =>
      t.prisma.$executeRawUnsafe(
        `INSERT INTO privacy_settings (user_id, profile, forest, statistics, badges, current_tree, updated_at)
         VALUES ($1::uuid, 'friends', $2::privacy_level, 'private', 'friends', 'friends', now())`,
        ada,
        forest,
      );
    await expect(insert('everyone')).rejects.toThrow();
    await expect(insert('public')).resolves.toBe(1);
  });

  describe('reactions (A5.2)', () => {
    const reaction = (
      reactorId: string,
      ownerId: string,
      targetType: 'forest' | 'tree' | 'badge',
      targetKey: string,
    ) =>
      t.prisma.reaction.create({
        data: {
          reactorId,
          ownerId,
          targetType,
          targetKey,
          reaction: 'fire',
          createdAt: new Date(),
        },
      });

    it('refuses reacting to yourself and malformed target keys', async () => {
      const { ada, bob } = await users();
      await expect(reaction(ada, ada, 'forest', '')).rejects.toThrow();
      await expect(reaction(ada, bob, 'forest', 'x')).rejects.toThrow();
      await expect(reaction(ada, bob, 'tree', '2026-13')).rejects.toThrow();
      await expect(reaction(ada, bob, 'badge', 'First')).rejects.toThrow();
      await reaction(ada, bob, 'tree', '2026-09');
      await reaction(ada, bob, 'badge', 'focus-streak:7');
      await expect(reaction(ada, bob, 'tree', '2026-09')).rejects.toThrow();
    });

    it('refuses a reaction while either user blocks the other', async () => {
      const { ada, bob } = await users();
      await t.prisma.block.create({
        data: { blockerId: bob, blockedId: ada, createdAt: new Date() },
      });
      await expect(reaction(ada, bob, 'forest', '')).rejects.toThrow(/blocked/);
      await expect(reaction(bob, ada, 'forest', '')).rejects.toThrow(/blocked/);
    });
  });
});
