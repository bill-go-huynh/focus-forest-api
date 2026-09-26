import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves path aliases declared in tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    // Placeholder values so config validation passes. Tests do not connect to a database.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      JWT_ACCESS_SECRET: 'test-only-access-token-secret-0123456789',
    },
    include: ['**/*.spec.ts'],
  },
});
