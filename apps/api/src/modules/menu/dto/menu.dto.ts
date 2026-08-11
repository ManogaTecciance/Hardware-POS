import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// ── Menu ────────────────────────────────────────────────────────────────
export class CreateMenuDto {
  @IsString() @Length(1, 80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

export class UpdateMenuDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) expectedVersion?: number;
}

// ── Section ─────────────────────────────────────────────────────────────
export class CreateSectionDto {
  @IsString() @Length(1, 80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
}

export class UpdateSectionDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// ── Menu Item ───────────────────────────────────────────────────────────
export class ChannelPriceDto {
  @IsIn(['DINE_IN', 'TAKEAWAY', 'ONLINE']) channel!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price!: number;
}

export class AvailabilityWindowDto {
  @IsIn(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']) dayOfWeek!: string;
  @IsString() @Matches(HHMM, { message: 'startTime must be HH:MM' }) startTime!: string;
  @IsString() @Matches(HHMM, { message: 'endTime must be HH:MM' }) endTime!: string;
}

// Presentation-only fields added by the Restaurant Menu wizard. Kept as their
// own constants so the wizard, tests and DTO share one source of truth for the
// tag vocabulary and the itemType enum. Backed by the additive migration
// 20260811000000_add_menu_item_presentation_fields.
export const MENU_ITEM_TYPES = ['FOOD', 'BEVERAGE', 'DESSERT'] as const;
export type MenuItemTypeValue = (typeof MENU_ITEM_TYPES)[number];

export class CreateItemDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) basePrice!: number;
  @IsOptional() @IsString() @Length(1, 128) productId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) modifierGroupIds?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ChannelPriceDto)
  channelPrices?: ChannelPriceDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AvailabilityWindowDto)
  availability?: AvailabilityWindowDto[];
  @IsOptional() @IsArray() @IsString({ each: true }) stationIds?: string[];

  // ── Presentation fields ───────────────────────────────────────────────
  @IsOptional() @IsIn(MENU_ITEM_TYPES) itemType?: MenuItemTypeValue;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(360) prepMinutes?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) dietaryTags?: string[];
  @IsOptional() @IsString() @MaxLength(2048) imageUrl?: string;
}

export class UpdateItemDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) basePrice?: number;
  @IsOptional() @IsString() @Length(0, 128) productId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) modifierGroupIds?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ChannelPriceDto)
  channelPrices?: ChannelPriceDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AvailabilityWindowDto)
  availability?: AvailabilityWindowDto[];
  @IsOptional() @IsArray() @IsString({ each: true }) stationIds?: string[];

  // Presentation fields — empty string clears imageUrl / prepMinutes explicitly.
  @IsOptional() @IsIn(MENU_ITEM_TYPES) itemType?: MenuItemTypeValue;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(360) prepMinutes?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) dietaryTags?: string[];
  @IsOptional() @IsString() @MaxLength(2048) imageUrl?: string;
}

// ── Modifier ────────────────────────────────────────────────────────────
export class ModifierOptionInputDto {
  @IsString() @Length(1, 80) name!: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) priceDelta?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
}

// Wizard uses 'SIZE' to mark the Small/Medium/Large group; NULL for ordinary
// modifier groups. Server enforces nothing on this string — kept small so
// mistyped values don't overflow. See ModifierGroup.role in the schema.
export const MODIFIER_GROUP_ROLES = ['SIZE'] as const;
export type ModifierGroupRoleValue = (typeof MODIFIER_GROUP_ROLES)[number];

export class CreateModifierGroupDto {
  @IsString() @Length(1, 80) name!: string;
  @IsOptional() @IsIn(['SINGLE', 'MULTIPLE']) selection?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minSelections?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) maxSelections?: number;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ModifierOptionInputDto)
  options!: ModifierOptionInputDto[];
  @IsOptional() @IsString() @Length(1, 32) role?: string;
}

export class UpdateModifierGroupDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsIn(['SINGLE', 'MULTIPLE']) selection?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minSelections?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) maxSelections?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ModifierOptionInputDto)
  options?: ModifierOptionInputDto[];
  @IsOptional() @IsString() @Length(1, 32) role?: string;
}
