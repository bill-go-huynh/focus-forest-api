import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AuditQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
