import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Length, Min } from 'class-validator';

/** D62 — collections/sections/entries DTOs. */
export class CreateCollectionDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(1, 500) description?: string;
}
export class UpdateCollectionDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @Length(1, 500) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
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
