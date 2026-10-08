import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';

import { MAX_EVENTS_PER_BATCH } from '../analytics-events.js';

/**
 * One event as the app sends it. Shape only: whether the name, platform, instant, and props are
 * kept is decided by `acceptEvent` (an unknown name is ignored, never refused, so an older API
 * accepts a newer app).
 */
export class AnalyticsEventDto {
  @IsUUID('all', { message: 'id must be a UUID.' })
  id!: string;

  @IsString()
  @Length(1, 64)
  name!: string;

  @IsISO8601({ strict: true }, { message: 'occurredAt must be an ISO 8601 instant.' })
  occurredAt!: string;

  @IsString()
  @Length(10, 10, { message: 'localDate must be a date like 2026-10-08.' })
  localDate!: string;

  @IsString()
  @Length(1, 16)
  platform!: string;

  @IsString()
  @Length(1, 32, { message: 'appVersion must be at most 32 characters.' })
  appVersion!: string;

  @IsOptional()
  @IsObject({ message: 'props must be an object.' })
  props?: Record<string, unknown>;
}

export class AnalyticsBatchDto {
  @IsArray({ message: 'events must be a list.' })
  @ArrayMaxSize(MAX_EVENTS_PER_BATCH, {
    message: `At most ${MAX_EVENTS_PER_BATCH} events can be sent at once.`,
  })
  @ValidateNested({ each: true })
  @Type(() => AnalyticsEventDto)
  events!: AnalyticsEventDto[];
}

export interface AnalyticsBatchResponse {
  /** Events kept (a duplicate id counts: it is already stored). */
  accepted: number;
  /** Events not kept: unknown, outside the window, or not shared. */
  ignored: number;
}
