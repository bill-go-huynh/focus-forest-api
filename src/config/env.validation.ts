import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
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
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, config);
  const errors = validateSync(env);
  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n${errors.toString()}`);
  }
  return env;
}
