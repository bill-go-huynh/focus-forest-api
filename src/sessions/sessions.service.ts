import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { Prisma, type FocusSession } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductConfigService } from '../product-config/product-config.service.js';
import { parseEventResult, type SessionEventResult } from '../events/events.dto.js';
import { EventsService } from '../events/events.service.js';
import { AchievementsService } from '../progression/achievements.service.js';
import type { SessionProgressionDto } from '../progression/badge.dto.js';
import { isCounted } from '../focus-stats/focus-stats.js';
import { closedMonthGrowth, parseGrowthResult } from '../trees/growth-result.js';
import { MonthClosureService } from '../trees/month-closure.service.js';
import { MonthlyTreesService } from '../trees/monthly-trees.service.js';
import type { GrowthResultDto } from '../trees/tree.contracts.js';
import { MonthAttributionService } from './attribution/month-attribution.service.js';
import { TimezoneRequiredError } from './attribution/month-context.js';
import {
  HISTORY_DEFAULT_LIMIT,
  type HistoryItem,
  type HistoryPage,
  type SessionResponse,
  type SubmitSessionDto,
} from './dto/session.dto.js';
import { decodeCursor, encodeCursor, historyFilterKey } from './history-cursor.js';
import { historyWhere, type HistoryFilters } from './history-filters.js';
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

/** Submission recomputes the month's tree in its transaction (A3.3): allow more than 5 s. */
const HEAVY_TRANSACTION = { timeout: 15_000 };

/** The answer to a submission: the session and what it did to its month's tree. */
export interface SubmittedSessionResponse extends SessionResponse {
  /** Stored with the session and returned unchanged on replays; null before Phase 3. */
  growth: GrowthResultDto | null;
  /**
   * What this session caused in progression (A4.2): the badges it earned. Stored with the
   * session and returned unchanged on replays, so an unlock is reported for its own session
   * only; null for sessions stored before A4.2.
   */
  progression: SessionProgressionDto | null;
  /**
   * A5.6: the joined events whose window holds this session, with mission progress, what it
   * completed, and the milestones it reached. Stored with the session; null before A5.6.
   */
  events: SessionEventResult[] | null;
}

export interface SubmitResult {
  session: SubmittedSessionResponse;
  created: boolean;
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProductConfigService,
    private readonly attribution: MonthAttributionService,
    private readonly trees: MonthlyTreesService,
    private readonly closure: MonthClosureService,
    private readonly achievements: AchievementsService,
    private readonly events: EventsService,
    private readonly clock: Clock,
  ) {}

  /**
   * Stores a completed session, or replays an earlier submission with the same id.
   * A replay returns what was stored; nothing is evaluated, attributed, or checked again.
   */
  async submit(userId: string, id: string, raw: SubmitSessionDto): Promise<SubmitResult> {
    const submission = canonicalSubmission(raw);

    const existing = await findSession(this.prisma, userId, id);
    if (existing) return { session: await this.replay(existing, submission), created: false };

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
    // Ended months close first, each in its own transaction, so a late session never grows one.
    await this.closure.closeEndedMonths(userId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Every submission of one user runs one at a time from here: the id re-check, the
        // overlap check, and the insert see each other. The only lock taken, so no deadlock.
        await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;

        const raced = await findSession(tx, userId, id);
        if (raced) return { session: await this.replay(raced, submission, tx), created: false };

        const topic = await tx.topic.findUnique({
          where: { userId_id: { userId, id: submission.topicId } },
          select: { id: true },
        });
        if (!topic) throw new NotFoundException('Topic not found.');

        const attribution = await this.attribution.attribute(userId, submission.startedAt, tx);
        // A context just created for an old month (an offline session) may already be due.
        await this.closure.closeEndedMonthsIn(tx, userId);

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
        // The tree grows from the stored sessions, this one included, in the same transaction.
        // A late session of a closed month is kept for history and statistics, but its archived
        // tree and recap never change.
        const growth = (await this.closure.isClosed(tx, userId, attribution))
          ? closedMonthGrowth(isCounted(row.status))
          : await this.trees.applySession(tx, userId, row);
        // Then achievements, from the same stored truth: a grant commits with its session, or
        // neither does (the app keeps the session and submits it again).
        const progression = await this.achievements.evaluateSession(tx, userId, row);
        // Then the joined events' missions, from the same stored truth (A5.6).
        const events = await this.events.evaluateSession(tx, userId, row);
        const stored = await tx.focusSession.update({
          where: { userId_id: { userId, id } },
          data: {
            growthResult: growth as unknown as Prisma.InputJsonValue,
            progressionResult: progression as unknown as Prisma.InputJsonValue,
            eventResult: events as unknown as Prisma.InputJsonValue,
          },
        });
        return { session: await this.toSubmittedResponse(stored, tx), created: true };
      }, HEAVY_TRANSACTION);
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
    query: HistoryFilters & { cursor?: string; limit?: number } = {},
  ): Promise<HistoryPage> {
    const { cursor, limit = HISTORY_DEFAULT_LIMIT, ...filters } = query;
    const resolved = historyWhere(filters);
    if ('error' in resolved) throw badRequest('invalid_history_filters', resolved.error);
    // A cursor continues only the list it came from: changing the filters starts over.
    const filterKey = historyFilterKey({ ...filters });
    const after = cursor === undefined ? null : decodeCursor(cursor);
    if (after && (after.filters ?? null) !== filterKey) {
      throw badRequest(
        'cursor_filters_changed',
        'This cursor belongs to other filters. Start again without it.',
      );
    }
    const rows = await this.prisma.focusSession.findMany({
      where: {
        userId,
        ...resolved.where,
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
      nextCursor: last ? encodeCursor({ startedAt: last.startedAt, id: last.id }, filterKey) : null,
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
        // Clearing the note clears its highlight: a highlight always has a note.
        data: { note, ...(note === null && { noteHighlighted: false }) },
      });
      return toResponse(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Session not found.');
      }
      throw error;
    }
  }

  /**
   * Highlights the note for its month's Tree Details and recap, or removes the highlight.
   * Idempotent. Only a session with a note can be highlighted.
   */
  async setNoteHighlight(
    userId: string,
    id: string,
    highlighted: boolean,
  ): Promise<SessionResponse> {
    // Conditional, so a note cleared at the same moment cannot leave a highlight without one.
    const { count } = await this.prisma.focusSession.updateMany({
      where: { userId, id, ...(highlighted && { note: { not: null } }) },
      data: { noteHighlighted: highlighted },
    });
    const row = await findSession(this.prisma, userId, id);
    if (!row) throw new NotFoundException('Session not found.');
    if (count === 0) throw unprocessable('note_required', 'Add a note before highlighting it.');
    return toResponse(row);
  }

  /**
   * A replay answers with what was stored, the growth and progression results included:
   * nothing is recomputed, so a badge is never reported again as new by a later replay.
   */
  private async replay(
    row: FocusSession,
    submission: CanonicalSubmission,
    client: Client = this.prisma,
  ): Promise<SubmittedSessionResponse> {
    if (submissionKey(storedSubmission(row)) !== submissionKey(submission)) {
      throw conflict('session_id_conflict', 'A different session was already saved with this id.');
    }
    return this.toSubmittedResponse(row, client);
  }

  private async toSubmittedResponse(
    row: FocusSession,
    client: Client = this.prisma,
  ): Promise<SubmittedSessionResponse> {
    return {
      ...toResponse(row),
      growth: row.growthResult === null ? null : parseGrowthResult(row.growthResult),
      progression: await this.achievements.progressionView(
        row.userId,
        row.progressionResult,
        client,
      ),
      events: parseEventResult(row.eventResult),
    };
  }
}

type Client = PrismaService | Prisma.TransactionClient;

function findSession(client: Client, userId: string, id: string): Promise<FocusSession | null> {
  return client.focusSession.findUnique({ where: { userId_id: { userId, id } } });
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
    noteHighlighted: row.noteHighlighted,
    createdAt: row.createdAt.toISOString(),
  };
}

// A machine-readable code lets clients react without parsing the message.
function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, error: 'Conflict', message, code });
}

function badRequest(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', message, code });
}

function unprocessable(code: string, message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    message,
    code,
  });
}
