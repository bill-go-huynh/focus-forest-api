import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  AdminController,
  AdminRoles,
  CurrentAdmin,
  type AuthenticatedAdmin,
} from '../admin/admin-route.decorator.js';
import { CurrentUser, type AuthenticatedUser } from '../identity/current-user.decorator.js';
import {
  FileReportDto,
  ModerationReasonDto,
  ReportQueueQuery,
  ResolveReportDto,
  type FiledReportResponse,
  type ReportDetail,
  type ReportQueueItem,
  type WarningResponse,
} from './dto/moderation.dto.js';
import { ModerationService } from './moderation.service.js';
import { ReportsService } from './reports.service.js';

const uuid = new ParseUUIDPipe();

/** Filing a report (spec §19.3): 201 when stored, 200 when an unfinished one already exists. */
@Controller('me/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  async file(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: FileReportDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<FiledReportResponse> {
    const { created, report } = await this.reports.file(user.userId, body);
    response.status(created ? 201 : 200);
    return report;
  }
}

/** Warnings a moderator sent the signed-in user (A5.3). */
@Controller('me/warnings')
export class WarningsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<{ items: WarningResponse[] }> {
    return this.reports.warnings(user.userId);
  }

  @Put(':id/acknowledged')
  @HttpCode(200)
  acknowledge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', uuid) id: string,
  ): Promise<WarningResponse> {
    return this.reports.acknowledge(user.userId, id);
  }
}

/** The reports queue (docs/09): admins and moderators only. */
@AdminController('reports')
@AdminRoles('admin', 'moderator')
export class AdminReportsController {
  constructor(private readonly moderation: ModerationService) {}

  @Get()
  queue(
    @Query() query: ReportQueueQuery,
  ): Promise<{ items: ReportQueueItem[]; nextCursor: string | null }> {
    return this.moderation.queue(query.status, query.cursor);
  }

  @Get(':id')
  detail(@Param('id', uuid) id: string): Promise<ReportDetail> {
    return this.moderation.detail(id);
  }

  @Post(':id/review')
  @HttpCode(200)
  review(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', uuid) id: string,
  ): Promise<ReportDetail> {
    return this.moderation.review(admin.adminId, id);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  resolve(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', uuid) id: string,
    @Body() body: ResolveReportDto,
  ): Promise<ReportDetail> {
    return this.moderation.resolve(admin.adminId, id, body);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  dismiss(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param('id', uuid) id: string,
    @Body() body: ModerationReasonDto,
  ): Promise<ReportDetail> {
    return this.moderation.dismiss(admin.adminId, id, body.reason);
  }
}
