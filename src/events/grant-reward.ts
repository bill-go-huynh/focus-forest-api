import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  ContentNotAcquirableError,
  type ProgressionOwnershipService,
} from '../progression/progression-ownership.service.js';

/**
 * Grants an event reward while its content is acquirable; owned forever after. Once its window
 * has ended, the milestone stays reached without it.
 */
export async function grantIfAcquirable(
  ownership: ProgressionOwnershipService,
  kind: 'badge' | 'cosmetic',
  userId: string,
  id: string,
  at: Date,
  client: PrismaService | Prisma.TransactionClient,
): Promise<void> {
  try {
    if (kind === 'badge') await ownership.grantBadge(userId, id, at, client);
    else await ownership.grantCosmetic(userId, id, at, client);
  } catch (error) {
    if (!(error instanceof ContentNotAcquirableError)) throw error;
  }
}
