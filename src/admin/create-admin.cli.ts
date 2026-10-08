import type { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../config/env.validation.js';
import { PasswordHasher } from '../identity/password-hasher.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { createAdmin } from './create-admin.js';

/**
 * `ADMIN_PASSWORD=… npm run admin:create -- --email ops@example.com --role admin`: the bootstrap
 * of the first admins (there is no admin-creation endpoint). The password comes from the
 * environment, never an argument, so it stays out of shell history and process lists. Runs
 * against DATABASE_URL; needs a build first (`npm run build`).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const email = arg('email');
  const password = process.env['ADMIN_PASSWORD'];
  const databaseUrl = process.env['DATABASE_URL'];
  if (!email || !password || !databaseUrl) {
    throw new Error(
      'Usage: DATABASE_URL=… ADMIN_PASSWORD=… npm run admin:create -- --email <email> [--role admin|support]',
    );
  }
  const config = { get: () => databaseUrl } as unknown as ConfigService<EnvironmentVariables, true>;
  const prisma = new PrismaService(config);
  try {
    const admin = await createAdmin(prisma, new PasswordHasher(), {
      email,
      role: arg('role') ?? 'support',
      password,
    });
    process.stdout.write(`Created ${admin.role} ${admin.email} (${admin.id}).\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
