import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { IsIanaTimeZone } from '../time-zone.js';

const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class SignUpDto {
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(8, { message: 'Use at least 8 characters for your password.' })
  @MaxLength(128, { message: 'Use at most 128 characters for your password.' })
  password: string;
}

export class SignInDto {
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  refreshToken: string;
}

/** W.2 `POST /auth/google`: the ID token the app got from Google, and the device time zone. */
export class GoogleSignInDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  idToken: string;

  /** Saved to a new account's profile, like sign-up's first profile update. */
  @IsOptional()
  @IsIanaTimeZone()
  timezone?: string;
}
