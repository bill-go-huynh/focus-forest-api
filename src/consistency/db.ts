import type { LocalDate } from '../common/local-date.js';
import type { Prisma } from '../generated/prisma/client.js';

/** A DATE column value: midnight UTC of the calendar date. */
export function dbDate(date: LocalDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function localDateFromDb(value: Date): LocalDate {
  return value.toISOString().slice(0, 10);
}

/**
 * Serialises a user's consistency writes (goal changes, rest days, recoveries) with each other
 * and with session submissions, which take the same lock.
 */
export async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
}
