import { IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

/** `POST /admin/integrity/dismissals` (A7.3): a flag staff looked at, and why it is fine. */
export class DismissFlagDto {
  @IsUUID('all', { message: 'userId must be a user id.' })
  userId!: string;

  @IsString()
  @Matches(/^(overlap|day|late|spike):/, { message: 'key must be a flag key.' })
  @MaxLength(200)
  key!: string;

  @IsString()
  @MinLength(3, { message: 'reason must say why, in 3 to 500 characters.' })
  @MaxLength(500, { message: 'reason must say why, in 3 to 500 characters.' })
  reason!: string;
}
