import { execFileSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client.js';

const MIGRATIONS_TABLE = '_prisma_migrations';

/** Throws unless `url` points at a database whose name ends with `_test`. */
export function assertTestDatabaseUrl(url: string | undefined): asserts url is string {
  let databaseName: string;
  try {
    databaseName = new URL(url ?? '').pathname.replace(/^\//, '');
  } catch {
    throw new Error('TEST_DATABASE_URL is missing or not a valid connection URL.');
  }
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to use "${databaseName}": integration tests only run against a test database (name ending in _test).`,
    );
  }
}

export function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL'];
  assertTestDatabaseUrl(url);
  return url;
}

export function createTestPrismaClient(url: string = testDatabaseUrl()): PrismaClient {
  assertTestDatabaseUrl(url);
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/**
 * Drops everything in the test database, then applies all migrations from scratch, and keeps a
 * copy of the content the migrations left (`snapshotContent`).
 */
export async function migrateFreshTestDatabase(url: string = testDatabaseUrl()): Promise<void> {
  const prisma = createTestPrismaClient(url);
  try {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA} CASCADE`);
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
    // The local CLI binary, not `npx`, which adds seconds of package resolution.
    execFileSync('node_modules/.bin/prisma', ['migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
    await snapshotContent(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

/** Empties every table except the migration history, and restarts identity sequences. */
export async function resetTestDatabase(prisma: PrismaClient): Promise<void> {
  const [database] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (!database?.name.endsWith('_test')) {
    throw new Error(`Refusing to reset "${database?.name ?? 'unknown'}": not a test database.`);
  }

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> ${MIGRATIONS_TABLE}`;
  if (tables.length === 0) return;

  const list = tables.map(({ tablename }) => `"public"."${tablename.replaceAll('"', '""')}"`);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list.join(', ')} RESTART IDENTITY CASCADE`);
  await seedContent(prisma);
}

/**
 * The content definitions migrations ship (progression catalog, A4.1), in foreign-key order.
 * Reference data, not configuration: integration tests start without configuration.
 */
export const CONTENT_TABLES = [
  'badge_definitions',
  'achievement_definitions',
  'tree_species',
  'cosmetic_definitions',
] as const;

/** Where the migrated content is kept, outside `public`, so a reset never empties it. */
const SNAPSHOT_SCHEMA = 'content_snapshot';

/**
 * Copies the content tables as the migrations left them, so an emptied test database gets
 * exactly that content back, as a migrated database has it: seeds and later changes (such as
 * the content removed with events, 2026-10-22) alike.
 */
async function snapshotContent(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA ${SNAPSHOT_SCHEMA}`);
  for (const table of CONTENT_TABLES) {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE ${SNAPSHOT_SCHEMA}."${table}" AS TABLE public."${table}"`,
    );
  }
}

/** Puts the migrated content back into emptied content tables. */
export async function seedContent(prisma: PrismaClient): Promise<void> {
  for (const table of CONTENT_TABLES) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."${table}" SELECT * FROM ${SNAPSHOT_SCHEMA}."${table}"`,
    );
  }
}
