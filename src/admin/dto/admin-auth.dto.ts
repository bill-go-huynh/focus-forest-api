import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class AdminSignInDto {
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}

export interface AdminIdentity {
  id: string;
  email: string;
  role: 'admin' | 'support';
}

export interface AdminSignInResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  admin: AdminIdentity;
}
