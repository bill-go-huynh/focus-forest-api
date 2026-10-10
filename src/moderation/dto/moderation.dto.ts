import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Length, MaxLength, ValidateIf } from 'class-validator';

import type {
  ModerationAction,
  ReportCategory,
  ReportStatus,
} from '../../generated/prisma/client.js';

export const REPORT_CATEGORIES: readonly ReportCategory[] = [
  'account',
  'username',
  'avatar',
  'bio',
  'behavior',
];
export const REPORT_STATUSES: readonly ReportStatus[] = [
  'open',
  'in_review',
  'resolved',
  'dismissed',
];
export const MODERATION_ACTIONS: readonly ModerationAction[] = [
  'none',
  'warn',
  'reset_username',
  'reset_bio',
  'reset_avatar',
  'suspend',
  'ban',
];

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const trimmedToNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text === '' ? null : text;
};

/** `POST /me/reports` (spec §19.3). */
export class FileReportDto {
  @IsUUID('all', { message: 'userId must be a user id.' })
  userId!: string;

  @IsIn(REPORT_CATEGORIES, { message: `category must be one of: ${REPORT_CATEGORIES.join(', ')}.` })
  category!: ReportCategory;

  /** Optional words for the moderators; blank is none. */
  @Transform(trimmedToNull)
  @IsOptional()
  @IsString({ message: 'details must be text.' })
  @MaxLength(500, { message: 'details can be at most 500 characters.' })
  details?: string | null;
}

export interface FiledReportResponse {
  id: string;
  category: ReportCategory;
  status: ReportStatus;
  createdAt: string;
}

export interface WarningResponse {
  id: string;
  message: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

export class ReportQueueQuery {
  @ValidateIf((query: ReportQueueQuery) => query.status !== undefined)
  @IsIn(REPORT_STATUSES, { message: `status must be one of: ${REPORT_STATUSES.join(', ')}.` })
  status?: ReportStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

/** Every moderation decision states why (docs/09). */
export class ModerationReasonDto {
  @Transform(trimmed)
  @IsString({ message: 'Give a reason.' })
  @Length(3, 500, { message: 'Give a reason of 3 to 500 characters.' })
  reason!: string;
}

export class ResolveReportDto extends ModerationReasonDto {
  @IsIn(MODERATION_ACTIONS, { message: `action must be one of: ${MODERATION_ACTIONS.join(', ')}.` })
  action!: ModerationAction;

  /** Required for `warn`: what the user reads in the app. */
  @Transform(trimmedToNull)
  @IsOptional()
  @IsString({ message: 'message must be text.' })
  @MaxLength(500, { message: 'message can be at most 500 characters.' })
  message?: string | null;
}

export interface ReportPerson {
  id: string;
  email: string;
  username: string | null;
  displayName: string | null;
}

export interface ReportQueueItem {
  id: string;
  category: ReportCategory;
  status: ReportStatus;
  details: string | null;
  createdAt: string;
  /** Null once the reporter deleted their account. */
  reporter: ReportPerson | null;
  target: ReportPerson & { status: 'active' | 'suspended' | 'banned'; openReports: number };
}

export interface ReportDetail extends ReportQueueItem {
  /** The reported user's profile as it is now. */
  targetProfile: {
    username: string | null;
    displayName: string | null;
    bio: string | null;
    avatarUrl: string | null;
  };
  /** Blocks between the reporter and the reported user (docs/09). */
  blocks: { reporterBlocksTarget: boolean; targetBlocksReporter: boolean };
  targetHistory: { reports: number; warnings: number; status: 'active' | 'suspended' | 'banned' };
  /** The reviewing admin's email. */
  reviewedBy: string | null;
  resolution: {
    action: ModerationAction | null;
    reason: string;
    resolvedBy: string | null;
    resolvedAt: string;
  } | null;
}
