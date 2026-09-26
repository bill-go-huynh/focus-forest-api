import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  createTestPrismaClient,
  migrateFreshTestDatabase,
  resetTestDatabase,
  testDatabaseUrl,
} from './test-database.js';

type TestPrismaClient = ReturnType<typeof createTestPrismaClient>;

async function tableExists(prisma: TestPrismaClient, table: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS "exists"`;
  return rows[0]?.exists ?? false;
}

describe('test database', () => {
  let prisma: TestPrismaClient;

  beforeAll(() => {
    prisma = createTestPrismaClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('runs integration tests against the dedicated test database', async () => {
    const rows = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    expect(rows[0]?.name).toMatch(/_test$/);
    expect(testDatabaseUrl()).toMatch(/_test(\?|$)/);
  });

  it('migrates from an empty database', async () => {
    await prisma.$executeRawUnsafe('CREATE TABLE leftover_table (id int)');

    await migrateFreshTestDatabase();

    expect(await tableExists(prisma, 'leftover_table')).toBe(false);
    expect(await tableExists(prisma, '_prisma_migrations')).toBe(true);
  });

  it('removes all rows between tests and keeps the migration history', async () => {
    await prisma.$executeRawUnsafe('CREATE TABLE reset_probe (id serial PRIMARY KEY, label text)');
    await prisma.$executeRawUnsafe(`INSERT INTO reset_probe (label) VALUES ('a'), ('b')`);
    const migrationsBefore = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM _prisma_migrations`;

    await resetTestDatabase(prisma);

    const probe = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM reset_probe`;
    const migrationsAfter = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM _prisma_migrations`;
    expect(probe[0]?.count).toBe(0n);
    expect(migrationsAfter[0]?.count).toBe(migrationsBefore[0]?.count);

    // Identity sequences restart, so ids are deterministic in every test.
    await prisma.$executeRawUnsafe(`INSERT INTO reset_probe (label) VALUES ('c')`);
    const ids = await prisma.$queryRaw<{ id: number }[]>`SELECT id FROM reset_probe`;
    expect(ids[0]?.id).toBe(1);

    await prisma.$executeRawUnsafe('DROP TABLE reset_probe');
  });

  it('connects the application PrismaService to the test database', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const appPrisma = moduleRef.get(PrismaService);

    const rows = await appPrisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    expect(rows[0]?.name).toMatch(/_test$/);

    await moduleRef.close();
  });
});

describe('automatic reset between tests', () => {
  let prisma: TestPrismaClient;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    await prisma.$executeRawUnsafe('CREATE TABLE auto_reset_probe (id serial PRIMARY KEY)');
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE auto_reset_probe');
    await prisma.$disconnect();
  });

  it('writes a row', async () => {
    await prisma.$executeRawUnsafe('INSERT INTO auto_reset_probe DEFAULT VALUES');
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM auto_reset_probe`;
    expect(rows[0]?.count).toBe(1n);
  });

  it('does not see rows written by the previous test', async () => {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM auto_reset_probe`;
    expect(rows[0]?.count).toBe(0n);
  });
});
