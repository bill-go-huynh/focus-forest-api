import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  /** Signs access tokens. At least 32 random characters; never logged or committed. */
  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET: string;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(3600)
  ACCESS_TOKEN_TTL_SECONDS: number = 900;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  REFRESH_TOKEN_TTL_DAYS: number = 30;

  /**
   * Signs admin tokens (CR.3): at least 32 random characters, different from JWT_ACCESS_SECRET.
   * Without it the admin is off (every admin route answers 503).
   */
  @IsOptional()
  @IsString()
  @MinLength(32)
  ADMIN_JWT_SECRET?: string;

  /** Admin tokens are short-lived and not refreshed. */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(3600)
  ADMIN_TOKEN_TTL_SECONDS: number = 1800;

  /** Browser origins allowed to call the API (the admin web app), comma separated. */
  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  /**
   * A6.1: `expo` delivers push notifications through Expo's push service. Without it nothing is
   * delivered, and each attempt is recorded as failed (`PushDisabled`).
   */
  @IsEnum(['none', 'expo'])
  PUSH_PROVIDER: 'none' | 'expo' = 'none';

  /** Expo access token, when the Expo project requires signed push requests. */
  @IsOptional()
  @IsString()
  EXPO_ACCESS_TOKEN?: string;

  /** How often the background worker runs due jobs and notifications; 0 turns it off. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3600)
  JOBS_POLL_SECONDS: number = 15;

  /**
   * A7.2: `off` turns rate limits off. The integration tests run with it off (one address signs
   * up many people); their rate-limit test turns it back on. Never off in production.
   */
  @IsEnum(['on', 'off'])
  RATE_LIMITS: 'on' | 'off' = 'on';
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, config);
  const errors = validateSync(env);
  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n${errors.toString()}`);
  }
  return env;
}
