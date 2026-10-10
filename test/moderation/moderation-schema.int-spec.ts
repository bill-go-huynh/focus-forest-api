import { ConsistencyHarness } from '../support/consistency-harness.js';

/** A5.3: the database keeps reports consistent even without the service. */
describe('moderation schema (A5.3, PostgreSQL)', () => {
  const t = new ConsistencyHarness('2026-10-09T10:00:00.000Z');
  beforeAll(() => t.start());
  afterAll(() => t.stop());

  const users = async () => {
    const ada = await t.signUp('ada@example.com');
    const bob = await t.signUp('bob@example.com');
    return { ada: ada.userId, bob: bob.userId };
  };
  const now = new Date('2026-10-09T10:00:00.000Z');

  it('refuses self-reports and two unfinished reports of the same kind', async () => {
    const { ada, bob } = await users();
    await expect(
      t.prisma.report.create({
        data: { reporterId: ada, targetId: ada, category: 'bio', createdAt: now },
      }),
    ).rejects.toThrow();
    await t.prisma.report.create({
      data: { reporterId: ada, targetId: bob, category: 'bio', createdAt: now },
    });
    await expect(
      t.prisma.report.create({
        data: {
          reporterId: ada,
          targetId: bob,
          category: 'bio',
          createdAt: now,
          status: 'in_review',
        },
      }),
    ).rejects.toThrow();
    // A closed report does not count.
    await t.prisma.report.create({
      data: {
        reporterId: ada,
        targetId: bob,
        category: 'bio',
        createdAt: now,
        status: 'dismissed',
        resolvedAt: now,
        resolutionReason: 'ok',
      },
    });
  });

  it('keeps the resolution consistent with the status', async () => {
    const { ada, bob } = await users();
    const base = { reporterId: ada, targetId: bob, category: 'account' as const, createdAt: now };
    await expect(
      t.prisma.report.create({ data: { ...base, status: 'resolved', resolvedAt: now } }),
    ).rejects.toThrow();
    await expect(
      t.prisma.report.create({ data: { ...base, status: 'open', resolvedAt: now } }),
    ).rejects.toThrow();
    // Resolved needs an action as well as a reason.
    await expect(
      t.prisma.report.create({
        data: { ...base, status: 'resolved', resolvedAt: now, resolutionReason: 'x' },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.report.create({
        data: {
          ...base,
          status: 'dismissed',
          resolvedAt: now,
          resolutionReason: 'x',
          action: 'warn',
        },
      }),
    ).rejects.toThrow();
    await t.prisma.report.create({
      data: {
        ...base,
        status: 'resolved',
        resolvedAt: now,
        resolutionReason: 'x',
        action: 'none',
      },
    });
  });
});
