import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { Prisma, type Topic, type TopicStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateTopicDto, TopicResponse, TopicSort, UpdateTopicDto } from './dto/topic.dto.js';
import { createFingerprint } from './topic-fields.js';

const NAME_TAKEN = 'That name is already used by another topic.';

export interface PutTopicResult {
  topic: TopicResponse;
  created: boolean;
}

// Every query filters by the signed-in user, so another user's topic is simply not found.
@Injectable()
export class TopicsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** In creation order, or by latest use with `recent`. Two queries, whatever the count. */
  async list(userId: string, status?: TopicStatus, sort?: TopicSort): Promise<TopicResponse[]> {
    const topics = await this.prisma.topic.findMany({
      where: { userId, status },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const items = await this.present(userId, topics);
    if (sort !== 'recent') return items;
    // Stable: equal latest uses, and all unused topics, keep creation order.
    return items.sort((a, b) => usedAt(b) - usedAt(a));
  }

  /**
   * Creates the topic, or replays an earlier create with the same id and payload.
   * The same id with a different payload is a conflict, whatever edits happened since.
   */
  async put(userId: string, id: string, fields: CreateTopicDto): Promise<PutTopicResult> {
    const canonical = { ...fields, description: fields.description ?? null };
    const fingerprint = createFingerprint(canonical);

    const existing = await this.find(userId, id);
    if (existing) return { topic: await this.replay(existing, fingerprint), created: false };

    try {
      const topic = await this.prisma.topic.create({
        data: { userId, id, ...canonical, createFingerprint: fingerprint },
      });
      return { topic: await this.presentOne(topic), created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Either a concurrent create with this id won, or the name is taken.
      const winner = await this.find(userId, id);
      if (winner) return { topic: await this.replay(winner, fingerprint), created: false };
      throw nameTaken();
    }
  }

  async update(userId: string, id: string, changes: UpdateTopicDto): Promise<TopicResponse> {
    return this.change(userId, id, {
      name: changes.name,
      icon: changes.icon,
      color: changes.color,
      description: changes.description,
    });
  }

  async archive(userId: string, id: string): Promise<TopicResponse> {
    const topic = await this.findOrThrow(userId, id);
    if (topic.status === 'archived') return this.presentOne(topic);
    return this.change(userId, id, { status: 'archived', archivedAt: this.clock.now() });
  }

  async restore(userId: string, id: string): Promise<TopicResponse> {
    const topic = await this.findOrThrow(userId, id);
    if (topic.status === 'active') return this.presentOne(topic);
    return this.change(userId, id, { status: 'active', archivedAt: null });
  }

  private async change(
    userId: string,
    id: string,
    data: Prisma.TopicUpdateInput,
  ): Promise<TopicResponse> {
    try {
      const topic = await this.prisma.topic.update({ where: { userId_id: { userId, id } }, data });
      return await this.presentOne(topic);
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound();
      }
      throw error;
    }
  }

  private replay(topic: Topic, fingerprint: string): Promise<TopicResponse> {
    if (topic.createFingerprint !== fingerprint) {
      throw conflict('topic_id_conflict', 'A different topic was already created with this id.');
    }
    return this.presentOne(topic);
  }

  private async presentOne(topic: Topic): Promise<TopicResponse> {
    const [response] = await this.present(topic.userId, [topic]);
    return response as TopicResponse;
  }

  /** Every response carries the same shape, so a client can replace its copy of a topic. */
  private async present(userId: string, topics: Topic[]): Promise<TopicResponse[]> {
    const latest = await this.latestSessions(
      userId,
      topics.map((topic) => topic.id),
    );
    return topics.map((topic) => {
      const session = latest.get(topic.id);
      return {
        ...toResponse(topic),
        lastUsedAt: session?.startedAt.toISOString() ?? null,
        lastPlannedMinutes: session?.plannedMinutes ?? null,
      };
    });
  }

  /**
   * The latest session of each topic: one top-1 lookup per topic in a single statement, so
   * start and planned minutes always come from the same row. Any status counts: this is a
   * usage signal, not a counting one.
   */
  private async latestSessions(
    userId: string,
    topicIds: string[],
  ): Promise<Map<string, { startedAt: Date; plannedMinutes: number }>> {
    if (topicIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<
      { topicId: string; startedAt: Date; plannedMinutes: number }[]
    >`
      SELECT t.topic_id AS "topicId", s.started_at AS "startedAt",
             s.planned_minutes AS "plannedMinutes"
      FROM unnest(${topicIds}::uuid[]) AS t(topic_id)
      CROSS JOIN LATERAL (
        SELECT started_at, planned_minutes
        FROM focus_sessions
        WHERE user_id = ${userId}::uuid AND topic_id = t.topic_id
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      ) AS s`;
    return new Map(rows.map(({ topicId, ...session }) => [topicId, session]));
  }

  private find(userId: string, id: string): Promise<Topic | null> {
    return this.prisma.topic.findUnique({ where: { userId_id: { userId, id } } });
  }

  private async findOrThrow(userId: string, id: string): Promise<Topic> {
    const topic = await this.find(userId, id);
    if (!topic) throw notFound();
    return topic;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

// A machine-readable code lets clients tell the two conflicts apart without parsing text.
function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, error: 'Conflict', message, code });
}

function nameTaken(): ConflictException {
  return conflict('topic_name_taken', NAME_TAKEN);
}

function notFound(): NotFoundException {
  return new NotFoundException('Topic not found.');
}

function usedAt(item: TopicResponse): number {
  return item.lastUsedAt === null ? -Infinity : Date.parse(item.lastUsedAt);
}

type StoredFields = Omit<TopicResponse, 'lastUsedAt' | 'lastPlannedMinutes'>;

function toResponse(topic: Topic): StoredFields {
  return {
    id: topic.id,
    name: topic.name,
    icon: topic.icon,
    color: topic.color,
    description: topic.description,
    status: topic.status,
    archivedAt: topic.archivedAt?.toISOString() ?? null,
    createdAt: topic.createdAt.toISOString(),
    updatedAt: topic.updatedAt.toISOString(),
  };
}
