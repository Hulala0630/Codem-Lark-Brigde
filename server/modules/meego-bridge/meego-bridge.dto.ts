import { IsArray, IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';
import type { ConfirmGroupRequest } from '@shared/api.interface';

export class ConfirmGroupDto implements ConfirmGroupRequest {
  @IsUUID()
  pendingId!: string;

  @IsArray()
  @IsString({ each: true })
  bots!: string[];

  @IsBoolean()
  includeMe!: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  members?: string[];
}
