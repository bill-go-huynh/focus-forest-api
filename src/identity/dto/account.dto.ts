import { IsString, MaxLength, MinLength } from 'class-validator';

/** `DELETE /me` (A7.1): the account's password confirms the deletion. */
export class DeleteAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  password!: string;
}
