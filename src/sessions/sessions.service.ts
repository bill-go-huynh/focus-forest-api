import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { Prisma, type FocusSession } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { MonthAttributionService } from './attribution/month-attribution.service.js';
import { TimezoneRequiredError } from './attribution/month-context.js';
import {
  HISTORY_DEFAULT_LIMIT,
  type HistoryItem,
  type HistoryPage,
  type SessionResponse,
  type SubmitSessionDto,
} from './dto/session.dto.js';
import { decodeCursor, encodeCursor } from './history-cursor.js';
import { evaluateSession, type SessionRejectionReason } from './evaluation/evaluate-session.js';
import { canonicalSubmission, submissionKey, type CanonicalSubmission } from './submission.js';

const REJECTION_MESSAGES: Record<SessionRejectionReason, string> = {
  invalid_time: 'Times must be ISO 8601 instants with a time zone offset.',
  invalid_planned_duration:
    'The planned duration must be a whole number of minutes from 1 to 1440.',
  ends_before_start: 'The session ends before it starts.',
  ends_in_future: 'The session ends in the future.',
  pause_ends_before_start: 'A pause ends before it starts.',
  pause_outside_session: 'A pause lies outside the session.',
  pauses_out_of_order: 'Pauses must be in chronological order.',
  pauses_overlap: 'Pauses overlap.',
};

export interface SubmitResult {
  session: SessionResponse;
  created: boolean;
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly attribution: MonthAttributionService,
    private readonly clock: Clock,
  ) {}

  /**
   * Stores a completed session, or replays an earlier submission with the same id.
   * A replay returns what was stored; nothing is evaluated, attributed, or checked again.
   */
  async submit(userId: string, id: string, raw: SubmitSessionDto): Promise<SubmitResult> {
    const submission = canonicalSubmission(raw);

    const existing = await findSession(this.prisma, userId, id);
    if (existing) return { session: replay(existing, submission), created: false };

    // One configuration version for the whole evaluation. Rejections store nothing.
    const config = await this.config.active();
    const evaluation = evaluateSession(
      submission,
      {
        minValidMinutes: config.get('session.minValidMinutes'),
        maxPauseMinutes: config.get('session.maxPauseMinutes'),
      },
      this.clock.now(),
    );
    if (evaluation.kind === 'rejected') {
      throw unprocessable(evaluation.reason, REJECTION_MESSAGES[evaluation.reason]);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Every submission of one user runs one at a time from here: the id re-check, the
        // overlap check, and the insert see each other. The only lock taken, so no deadlock.
        await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;

        const raced = await findSession(tx, userId, id);
        if (raced) return { session: replay(raced, submission), created: false };

        const topic = await tx.topic.findUnique({
          where: { userId_id: { userId, id: submission.topicId } },
          select: { id: true },
        });
        if (!topic) throw new NotFoundException('Topic not found.');

        const attribution = await this.attribution.attribute(userId, submission.startedAt, tx);

        if (
          await overlapsStoredSession(tx, userId, submission.startedAt, evaluation.effectiveEnd)
        ) {
          throw conflict('session_overlap', 'This session overlaps another saved session.');
        }

        const row = await tx.focusSession.create({
          data: {
            id,
            userId,
            topicId: submission.topicId,
            startedAt: submission.startedAt,
            submittedEndedAt: submission.endedAt,
            plannedMinutes: submission.plannedMinutes,
            pauseIntervals: submission.pauses.map((pause) => ({
              startedAt: pause.startedAt.toISOString(),
              endedAt: pause.endedAt.toISOString(),
            })),
            effectiveEndedAt: evaluation.effectiveEnd,
            focusedMilliseconds: evaluation.focusedMilliseconds,
            pausedMilliseconds: evaluation.pausedMilliseconds,
            status: evaluation.status,
            localDate: new Date(`${attribution.localDate}T00:00:00.000Z`),
            year: attribution.year,
            month: attribution.month,
            configVersion: config.version,
          },
        });
        return { session: toResponse(row), created: true };
      });
    } catch (error) {
      if (error instanceof TimezoneRequiredError) throw unprocessable(error.code, error.message);
      throw error;
    }
  }

  /**
   * One page of the user's sessions, newest first, every status, each with its topic as it is
   * now. Keyset pagination on (startedAt DESC, id DESC); one extra row tells whether more exist.
   */
  async history(
    userId: string,
    cursor?: string,
    limit = HISTORY_DEFAULT_LIMIT,
  ): Promise<HistoryPage> {
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const rows = await this.prisma.focusSession.findMany({
      where: {
        userId,
        // `startedAt <= …` repeats what the OR implies so the (user_id, started_at) index can
        // seek to the cursor instead of filtering every newer row.
        ...(after && {
          startedAt: { lte: after.startedAt },
          OR: [
            { startedAt: { lt: after.startedAt } },
            { startedAt: after.startedAt, id: { lt: after.id } },
          ],
        }),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        topic: { select: { id: true, name: true, icon: true, color: true, status: true } },
      },
    });

    const items = rows.slice(0, limit).map(toHistoryItem);
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      items,
      nextCursor: last ? encodeCursor({ startedAt: last.startedAt, id: last.id }) : null,
    };
  }

  /**
   * Sets, replaces, or clears the note: the only change a stored session accepts. It is not
   * part of the submission, so replays of the original submission still match.
   */
  async updateNote(userId: string, id: string, note: string | null): Promise<SessionResponse> {
    try {
      const row = await this.prisma.focusSession.update({
        where: { userId_id: { userId, id } },
        data: { note },
      });
      return toResponse(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Session not found.');
      }
      throw error;
    }
  }
}

type Client = PrismaService | Prisma.TransactionClient;

function findSession(client: Client, userId: string, id: string): Promise<FocusSession | null> {
  return client.focusSession.findUnique({ where: { userId_id: { userId, id } } });
}

function replay(row: FocusSession, submission: CanonicalSubmission): SessionResponse {
  if (submissionKey(storedSubmission(row)) !== submissionKey(submission)) {
    throw conflict('session_id_conflict', 'A different session was already saved with this id.');
  }
  return toResponse(row);
}

function storedSubmission(row: FocusSession): CanonicalSubmission {
  const pauses = row.pauseIntervals as { startedAt: string; endedAt: string }[];
  return {
    topicId: row.topicId,
    startedAt: row.startedAt,
    endedAt: row.submittedEndedAt,
    plannedMinutes: row.plannedMinutes,
    pauses: pauses.map((pause) => ({
      startedAt: new Date(pause.startedAt),
      endedAt: new Date(pause.endedAt),
    })),
  };
}

/**
 * Whether [start, end) shares an instant with a stored session's [startedAt, effectiveEnd),
 * whatever its status. Half-open: touching sessions do not overlap, and an empty interval
 * (a session ended the moment it started) contains no instant, so it overlaps nothing.
 */
async function overlapsStoredSession(
  tx: Prisma.TransactionClient,
  userId: string,
  start: Date,
  end: Date,
): Promise<boolean> {
  if (start >= end) return false;
  const overlapping = await tx.focusSession.findFirst({
    where: {
      userId,
      startedAt: { lt: end },
      AND: [
        { effectiveEndedAt: { gt: start } },
        { effectiveEndedAt: { gt: tx.focusSession.fields.startedAt } },
      ],
    },
    select: { id: true },
  });
  return overlapping !== null;
}

function toHistoryItem(row: FocusSession & { topic: HistoryItem['topic'] }): HistoryItem {
  const { topic, ...session } = row;
  return { ...toResponse(session), topic };
}

function toResponse(row: FocusSession): SessionResponse {
  return {
    id: row.id,
    topicId: row.topicId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.effectiveEndedAt.toISOString(),
    plannedMinutes: row.plannedMinutes,
    focusedMilliseconds: row.focusedMilliseconds,
    pausedMilliseconds: row.pausedMilliseconds,
    status: row.status,
    counted: row.status !== 'discarded',
    localDate: row.localDate.toISOString().slice(0, 10),
    year: row.year,
    month: row.month,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

// A machine-readable code lets clients react without parsing the message.
function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, error: 'Conflict', message, code });
}

function unprocessable(code: string, message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message,
    code,
  });
}
