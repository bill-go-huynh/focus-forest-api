import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

// The database keeps these invariants whatever code writes the rows.
describe('monthly trees schema (PostgreSQL)', () => {
  let prisma: PrismaService;
  let close: () => Promise<void>;
  let userId: string;
  let configVersion: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    userId = (await prisma.user.create({ data: { email: 'ada@example.com', passwordHash: 'x' } }))
      .id;
    configVersion = (await prisma.productConfigVersion.create({ data: { values: {}, note: 't' } }))
      .version;
    await prisma.monthAttributionContext.create({
      data: {
        userId,
        year: 2026,
        month: 10,
        timezone: 'UTC',
        startsAt: new Date('2026-10-01T00:00:00Z'),
        endsAt: new Date('2026-11-01T00:00:00Z'),
      },
    });
  });

  const tree = (overrides: Record<string, unknown> = {}) => ({
    userId,
    year: 2026,
    month: 10,
    species: 'signature',
    variationSeed: 3_078_237_722n,
    configVersion,
    joinedOn: new Date('2026-01-01T00:00:00Z'),
    prorationNumerator: 1,
    prorationDenominator: 1,
    ...overrides,
  });

  it('holds one tree per user and month, for a month that has a context', async () => {
    await prisma.monthlyTree.create({ data: tree() });
    await expect(prisma.monthlyTree.create({ data: tree() })).rejects.toThrow();
    await expect(prisma.monthlyTree.create({ data: tree({ month: 11 }) })).rejects.toThrow();
  });

  it('references a stored configuration version', async () => {
    await expect(
      prisma.monthlyTree.create({ data: tree({ configVersion: configVersion + 100 }) }),
    ).rejects.toThrow();
  });

  it.each([
    ['a negative level', { fullnessLevel: -1 }],
    ['a seed beyond 32 bits', { variationSeed: 4_294_967_296n }],
    ['a negative seed', { variationSeed: -1n }],
    ['a zero proration denominator', { prorationDenominator: 0 }],
    ['a proration above 1', { prorationNumerator: 2, prorationDenominator: 1 }],
  ])('refuses %s', async (_, overrides) => {
    await expect(prisma.monthlyTree.create({ data: tree(overrides) })).rejects.toThrow();
  });

  it('holds each trait once per tree', async () => {
    await prisma.monthlyTree.create({ data: tree() });
    const trait = {
      userId,
      year: 2026,
      month: 10,
      traitId: 'monthly-focus-hours:10',
      earnedAt: new Date(),
    };
    await prisma.monthlyTreeTrait.create({ data: trait });
    await expect(prisma.monthlyTreeTrait.create({ data: trait })).rejects.toThrow();
  });

  const key = () => ({ userId_year_month: { userId, year: 2026, month: 10 } });
  const archive = () =>
    prisma.monthlyTree.update({
      where: key(),
      data: { status: 'archived', archivedAt: new Date(), archive: { snapshot: true } },
    });

  it('archives a tree only with its snapshot, and never changes it afterwards', async () => {
    await prisma.monthlyTree.create({ data: tree() });
    await expect(
      prisma.monthlyTree.update({ where: key(), data: { status: 'archived' } }),
    ).rejects.toThrow();
    await archive();
    await expect(
      prisma.monthlyTree.update({ where: key(), data: { blossomLevel: 3 } }),
    ).rejects.toThrow();
    await expect(
      prisma.monthlyTreeTrait.create({
        data: { userId, year: 2026, month: 10, traitId: 'streak-days:3', earnedAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it('holds a recap only for an archived tree; its content never changes, seen times once', async () => {
    await prisma.monthlyTree.create({ data: tree() });
    const recap = { userId, year: 2026, month: 10, content: { a: 1 }, createdAt: new Date() };
    await expect(prisma.monthlyRecap.create({ data: recap })).rejects.toThrow();
    await archive();
    await prisma.monthlyRecap.create({ data: recap });
    await expect(
      prisma.monthlyRecap.update({ where: key(), data: { content: { a: 2 } } }),
    ).rejects.toThrow();
    await prisma.monthlyRecap.update({ where: key(), data: { ceremonySeenAt: new Date() } });
    await expect(
      prisma.monthlyRecap.update({ where: key(), data: { ceremonySeenAt: new Date(0) } }),
    ).rejects.toThrow();
  });

  it('closes a month only after it ended', async () => {
    await expect(
      prisma.monthAttributionContext.update({
        where: key(),
        data: { closedAt: new Date('2026-10-31T00:00:00Z') },
      }),
    ).rejects.toThrow();
    await prisma.monthAttributionContext.update({
      where: key(),
      data: { closedAt: new Date('2026-11-01T00:00:00Z') },
    });
  });

  it('removes trees, archived ones too, their traits, and recaps with the user', async () => {
    await prisma.monthlyTree.create({ data: tree() });
    await prisma.monthlyTreeTrait.create({
      data: { userId, year: 2026, month: 10, traitId: 'streak-days:3', earnedAt: new Date() },
    });
    await archive();
    await prisma.monthlyRecap.create({
      data: { userId, year: 2026, month: 10, content: {}, createdAt: new Date() },
    });
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.monthlyRecap.count()).toBe(0);
    expect(await prisma.monthlyTree.count()).toBe(0);
    expect(await prisma.monthlyTreeTrait.count()).toBe(0);
  });
});
