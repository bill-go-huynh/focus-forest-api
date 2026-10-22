import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { NodeEnv, type EnvironmentVariables } from '../config/env.validation.js';
import { PasswordHasher } from '../identity/password-hasher.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * A ready admin for local testing (owner, 2026-10-22: "admin với cả admin123 … seed vào db").
 * Development only: its password is far below the 12-character rule real admins follow
 * (`createAdmin`), so it is never made in test or production. An existing one is left as it is.
 */
export const DEV_ADMIN = { email: 'admin@focusforest.test', password: 'admin123' } as const;

export async function seedDevAdmin(
  prisma: PrismaService,
  passwords: PasswordHasher,
  env: NodeEnv,
): Promise<'created' | 'exists' | 'skipped'> {
  if (env !== NodeEnv.Development) return 'skipped';
  if (await prisma.adminUser.findUnique({ where: { email: DEV_ADMIN.email } })) return 'exists';
  await prisma.adminUser.create({
    data: {
      id: randomUUID(),
      email: DEV_ADMIN.email,
      role: 'admin',
      passwordHash: await passwords.hash(DEV_ADMIN.password),
    },
  });
  return 'created';
}

/** Runs the seed when the API starts. */
@Injectable()
export class DevAdminSeed implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordHasher,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const result = await seedDevAdmin(
      this.prisma,
      this.passwords,
      this.config.get('NODE_ENV', { infer: true }),
    );
    if (result !== 'skipped') {
      new Logger('DevAdmin').log(
        `Development admin ${result === 'created' ? 'created' : 'ready'}: ${DEV_ADMIN.email} / ${DEV_ADMIN.password}`,
      );
    }
  }
}
