import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `DELETE /me` (A7.1): the account's password confirms the deletion. W.2: an account that signs
 * in only with Google confirms it with a fresh Google ID token for the same Google account.
 * Exactly one of the two is given (checked by the service).
 */
export class DeleteAccountDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  password?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  googleIdToken?: string;
}
