import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { OrderItemInputDto } from '../../table-sessions/dto/table-sessions.dto';

export class CreateTakeawayDto {
  @IsString() @Length(1, 128) branchId!: string;
  @IsOptional() @IsString() @Length(1, 120) customerName?: string;
  @IsOptional() @IsString() @Length(1, 40) customerPhone?: string;
  @IsOptional() @IsDateString() pickupAt?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];
  /** Idempotency key for the round submission. */
  @IsString() @Length(1, 128) idempotencyKey!: string;
}

export class UpdateTakeawayStatusDto {
  @IsIn(['PLACED', 'IN_KITCHEN', 'READY', 'HANDED_OVER', 'CANCELLED']) status!: string;
}
