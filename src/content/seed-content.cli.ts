import type { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { applyContentPack } from './apply-content-pack.js';
import { LAUNCH_CONTENT } from './launch-content.js';

/**
 * `DATABASE_URL=… npm run content:seed`: adds the launch content (events, Community Tree, seasonal
 * themes, and their badges) that is missing. Safe to rerun: existing content is never changed.
 * Needs a build first (`npm run build`).
 */
async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('Usage: DATABASE_URL=… npm run content:seed');
  const config = { get: () => databaseUrl } as unknown as ConfigService<EnvironmentVariables, true>;
  const prisma = new PrismaService(config);
  try {
    const { added, kept } = await applyContentPack(prisma, LAUNCH_CONTENT);
    const list = (ids: string[]) => (ids.length > 0 ? ids.join(', ') : 'none');
    process.stdout.write(
      [
        `Added ${added.badges} badges, events: ${list(added.events)}, themes: ${list(added.themes)}.`,
        `Kept as they are: ${kept.badges} badges, events: ${list(kept.events)}, themes: ${list(kept.themes)}.`,
        '',
      ].join('\n'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
