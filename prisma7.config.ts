import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Load a local .env for CLI commands (migrate, studio). In deployed
// environments DATABASE_URL comes from the real environment instead.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
