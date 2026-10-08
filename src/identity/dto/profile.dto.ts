import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

import { IsIanaTimeZone } from '../time-zone.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimToNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

// Length limits are an assumption: the docs only say "display name" and "short bio".
export const DISPLAY_NAME_MAX_LENGTH = 50;
export const BIO_MAX_LENGTH = 160;

/** Only these fields can be changed. The ValidationPipe rejects any other field. */
export class UpdateProfileDto {
  @ValidateIf((dto: UpdateProfileDto) => dto.displayName !== undefined)
  @Transform(trim)
  @IsString({ message: 'displayName must be text.' })
  @MinLength(1, { message: 'displayName cannot be empty.' })
  @MaxLength(DISPLAY_NAME_MAX_LENGTH, {
    message: `displayName can be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`,
  })
  @Matches(/^\P{Cc}*$/u, {
    message: 'displayName cannot contain line breaks or control characters.',
  })
  displayName?: string;

  /** Null or blank clears the bio. */
  @Transform(trimToNull)
  @IsOptional()
  @IsString({ message: 'bio must be text.' })
  @MaxLength(BIO_MAX_LENGTH, { message: `bio can be at most ${BIO_MAX_LENGTH} characters.` })
  bio?: string | null;

  @ValidateIf((dto: UpdateProfileDto) => dto.timezone !== undefined)
  @IsIanaTimeZone()
  timezone?: string;

  /** A5.1. Normalized and checked by the service (`username.ts`); it can be changed, never cleared. */
  @ValidateIf((dto: UpdateProfileDto) => dto.username !== undefined)
  @IsString({ message: 'username must be text.' })
  @MaxLength(64, { message: 'username is too long.' })
  username?: string;
}

export interface ProfileResponse {
  id: string;
  displayName: string | null;
  /** Always null until avatar upload exists. Clients show an initials-based avatar. */
  avatarUrl: string | null;
  bio: string | null;
  /** ISO 8601. Set by the server at sign-up, never editable. */
  joinDate: string;
  timezone: string | null;
  /** A5.1: the unique `@username`, lowercase. Null until chosen. */
  username: string | null;
}
