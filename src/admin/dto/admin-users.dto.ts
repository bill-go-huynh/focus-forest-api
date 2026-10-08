import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class UserSearchDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(254)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

export class PageDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

/** Every user-affecting action and every reveal states why (docs/09). */
export class ReasonDto {
  @Transform(trimmed)
  @IsString()
  @Length(3, 500, { message: 'Give a reason of 3 to 500 characters.' })
  reason!: string;
}

export class DeleteUserDto extends ReasonDto {
  /** The user's email, typed again: deletion cannot be undone. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MaxLength(254)
  confirmEmail!: string;
}

export class CohortQueryDto {
  @IsString()
  @Length(10, 10, { message: 'from must be a date like 2026-10-01.' })
  from!: string;

  @IsString()
  @Length(10, 10, { message: 'to must be a date like 2026-10-31.' })
  to!: string;
}
