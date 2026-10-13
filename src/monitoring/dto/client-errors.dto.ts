import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** One crash or error an app saw (A7.4). The server cuts long text and removes emails. */
export class ClientErrorDto {
  @IsISO8601({ strict: true }, { message: 'occurredAt must be an ISO 8601 instant.' })
  occurredAt!: string;

  @IsIn(['crash', 'error'], { message: 'kind must be crash or error.' })
  kind!: 'crash' | 'error';

  @IsIn(['ios', 'android'], { message: 'platform must be ios or android.' })
  platform!: 'ios' | 'android';

  @IsString()
  @Length(1, 32)
  appVersion!: string;

  /** The route or screen name, when the app knows it. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  screen?: string | null;

  @IsString()
  @Length(1, 5000)
  message!: string;

  @IsOptional()
  @IsString()
  @Length(1, 20_000)
  stack?: string | null;
}

/** `POST /client-errors`: up to twenty at a time. */
export class ClientErrorBatchDto {
  @ValidateNested({ each: true })
  @Type(() => ClientErrorDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  errors!: ClientErrorDto[];
}

/** `GET /admin/client-errors?days=` (1–30, default 7). */
export class ClientErrorQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  days?: number;
}
