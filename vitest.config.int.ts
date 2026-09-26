import { defineConfig } from 'vitest/config';

const DEFAULT_TEST_DATABASE_URL =
  'postgresql://focus_forest:focus_forest@localhost:5432/focus_forest_test?schema=public';

// Integration tests run against a real PostgreSQL test database (`npm run db:up`).
// Override the target with TEST_DATABASE_URL; its name must end with `_test`.
const testDatabaseUrl = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
// globalSetup runs in the main process, which does not receive `test.env`.
process.env['TEST_DATABASE_URL'] = testDatabaseUrl;

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    env: {
      NODE_ENV: 'test',
      TEST_DATABASE_URL: testDatabaseUrl,
      DATABASE_URL: testDatabaseUrl,
      JWT_ACCESS_SECRET: 'test-only-access-token-secret-0123456789',
    },
    include: ['**/*.int-spec.ts'],
    globalSetup: ['./test/database/global-setup.ts'],
    setupFiles: ['./test/database/reset-between-tests.ts'],
    // All files share one database, so they must not run concurrently.
    fileParallelism: false,
    // Some tests rebuild the database with the Prisma CLI, which takes a few seconds.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
