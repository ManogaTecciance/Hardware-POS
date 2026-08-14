import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';
import { OrderChannel } from '@hardware-pos/database';

const ORDER_CHANNELS = ['COUNTER', 'DINE_IN', 'TAKEAWAY', 'ONLINE'] as const;

/** D62 — collections/sections/entries DTOs. D66 adds channel scoping. */
export class CreateCollectionDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(1, 500) description?: string;
  /** D66 — channels this collection applies to. Omitted/empty = all. */
  @IsOptional() @IsArray() @IsIn(ORDER_CHANNELS, { each: true })
  channels?: OrderChannel[];
}
export class UpdateCollectionDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @Length(1, 500) description?: string;
  /** D66 — replace the channel scope; [] widens back to all channels. */
  @IsOptional() @IsArray() @IsIn(ORDER_CHANNELS, { each: true })
  channels?: OrderChannel[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}
export class ListCollectionsQueryDto {
  /** D66 — only assortments applying to this channel (scoped or unscoped). */
  @IsOptional() @IsIn(ORDER_CHANNELS)
  channel?: OrderChannel;
}
export class CreateSectionDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(1, 500) description?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
}
export class UpdateSectionDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @Length(1, 500) description?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
export class CreateEntryDto {
  @IsString() productId!: string;
  @IsOptional() @IsString() productVariantId?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) priceOverride?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
}
export class UpdateEntryDto {
  /** null clears the override — the product's price applies again. */
  @IsOptional() priceOverride?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
