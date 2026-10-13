import { IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** `GET /admin/audit-log`: a page, filtered by admin, action, target, and time (A6.6). */
export class AuditQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @IsUUID('all', { message: 'adminId must be an admin id.' })
  adminId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  targetId?: string;

  /** From this instant, inclusive. */
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'from must be an ISO 8601 instant.' })
  from?: string;

  /** Before this instant. */
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'to must be an ISO 8601 instant.' })
  to?: string;
}
