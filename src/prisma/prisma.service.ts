import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';

import type { EnvironmentVariables } from '../config/env.validation.js';
import { PrismaClient } from '../generated/prisma/client.js';

// Connects lazily on the first query, so the API can boot without a database.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService<EnvironmentVariables, true>) {
    super({
      adapter: new PrismaPg({ connectionString: config.get('DATABASE_URL', { infer: true }) }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
