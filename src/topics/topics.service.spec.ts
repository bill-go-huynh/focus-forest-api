import { ConflictException } from '@nestjs/common';

import { FixedClock } from '../common/clock.js';
import { Prisma, type Topic } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { createFingerprint } from './topic-fields.js';
import { TopicsService } from './topics.service.js';

const fields = { name: 'Reading', icon: 'book', color: 'topic.1', description: null };

function storedTopic(fingerprintOf = fields): Topic {
  const at = new Date('2026-09-27T10:00:00.000Z');
  return {
    id: 'topic-1',
    userId: 'user-1',
    ...fingerprintOf,
    status: 'active',
    archivedAt: null,
    createFingerprint: createFingerprint(fingerprintOf),
    createdAt: at,
    updatedAt: at,
  };
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

// Reproduces the race the database decides: the first read finds nothing, the insert loses
// to a concurrent request, and the second read finds what that request stored.
function racingService(winner: Topic | null) {
  const findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
  const create = vi.fn().mockRejectedValue(uniqueViolation());
  const $queryRaw = vi.fn().mockResolvedValue([]);
  const prisma = { topic: { findUnique, create }, $queryRaw } as unknown as PrismaService;
  return new TopicsService(prisma, new FixedClock(new Date(0)));
}

describe('TopicsService.put when a concurrent request wins the insert', () => {
  it('replays the winner when it was the same create', async () => {
    const result = await racingService(storedTopic()).put('user-1', 'topic-1', fields);
    expect(result).toMatchObject({ created: false, topic: { id: 'topic-1', name: 'Reading' } });
  });

  it('reports an id conflict when the winner was a different create', async () => {
    const other = storedTopic({ ...fields, name: 'Piano' });
    await expect(racingService(other).put('user-1', 'topic-1', fields)).rejects.toMatchObject({
      response: { code: 'topic_id_conflict' },
    });
  });

  it('reports the name as taken when no topic has this id', async () => {
    const error: unknown = await racingService(null)
      .put('user-1', 'topic-1', fields)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error).toMatchObject({ response: { code: 'topic_name_taken' } });
  });
});
