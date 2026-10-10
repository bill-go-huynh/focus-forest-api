import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

import { Clock } from '../common/clock.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { FiledReportResponse, FileReportDto, WarningResponse } from './dto/moderation.dto.js';

const UNFINISHED = ['open', 'in_review'] as const;

/**
 * A5.3, the user's side (spec §19.3): filing reports, and reading the warnings moderators sent.
 * Anyone who exists can be reported, a blocked or suspended user included: reporting is never
 * blocked. A repeat of an unfinished report (same user and category) finds the first.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async file(
    reporterId: string,
    input: FileReportDto,
  ): Promise<{ created: boolean; report: FiledReportResponse }> {
    if (input.userId === reporterId) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'You cannot report yourself.',
        code: 'cannot_report_self',
      });
    }
    const exists = await this.prisma.user.count({ where: { id: input.userId } });
    if (exists === 0) throw new NotFoundException('User not found.');

    const existing = () =>
      this.prisma.report.findFirst({
        where: {
          reporterId,
          targetId: input.userId,
          category: input.category,
          status: { in: [...UNFINISHED] },
        },
      });
    // The partial unique index decides: a repeat of an unfinished report finds the first.
    try {
      const report = await this.prisma.report.create({
        data: {
          reporterId,
          targetId: input.userId,
          category: input.category,
          details: input.details ?? null,
          createdAt: this.clock.now(),
        },
      });
      return { created: true, report: toFiled(report) };
    } catch (error) {
      // A repeat, or a concurrent one, hit the unique index: answer with the first report.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await existing();
        if (raced) return { created: false, report: toFiled(raced) };
      }
      throw error;
    }
  }

  async warnings(userId: string): Promise<{ items: WarningResponse[] }> {
    const rows = await this.prisma.userWarning.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { items: rows.map(toWarning) };
  }

  /** Idempotent: the first acknowledgement time is kept. */
  async acknowledge(userId: string, warningId: string): Promise<WarningResponse> {
    await this.prisma.userWarning.updateMany({
      where: { id: warningId, userId, acknowledgedAt: null },
      data: { acknowledgedAt: this.clock.now() },
    });
    const warning = await this.prisma.userWarning.findFirst({ where: { id: warningId, userId } });
    if (!warning) throw new NotFoundException('Warning not found.');
    return toWarning(warning);
  }
}

function toFiled(report: {
  id: string;
  category: FiledReportResponse['category'];
  status: FiledReportResponse['status'];
  createdAt: Date;
}): FiledReportResponse {
  return {
    id: report.id,
    category: report.category,
    status: report.status,
    createdAt: report.createdAt.toISOString(),
  };
}

function toWarning(warning: {
  id: string;
  message: string;
  createdAt: Date;
  acknowledgedAt: Date | null;
}): WarningResponse {
  return {
    id: warning.id,
    message: warning.message,
    createdAt: warning.createdAt.toISOString(),
    acknowledgedAt: warning.acknowledgedAt?.toISOString() ?? null,
  };
}
