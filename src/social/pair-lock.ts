import type { Prisma } from '../generated/prisma/client.js';

/**
 * One lock per unordered pair of users, held until the transaction ends. Follows, reactions, and
 * blocks of the same pair take it, so a block never races past a follow or a reaction (A5.1).
 */
export async function lockPair(tx: Prisma.TransactionClient, a: string, b: string): Promise<void> {
  const key = a < b ? `social:${a}:${b}` : `social:${b}:${a}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
}

export async function blockedEitherWay(
  tx: Prisma.TransactionClient,
  a: string,
  b: string,
): Promise<boolean> {
  const count = await tx.block.count({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
  });
  return count > 0;
}
