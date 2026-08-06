import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// ── Session ──────────────────────────────────────────────────
export class OpenSessionDto {
  @IsString() @Length(1, 128) tableId!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) guestCount?: number;
  @IsOptional() @IsString() @Length(1, 128) waiterUserId?: string;
}

// ── Item + modifiers to include in a round ───────────────────
export class OrderItemModifierInputDto {
  @IsString() @Length(1, 128) modifierOptionId!: string;
}

export class OrderItemInputDto {
  @IsString() @Length(1, 128) menuItemId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) quantity!: number;
  @IsOptional() @IsString() @MaxLength(500) specialInstructions?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => OrderItemModifierInputDto)
  modifiers?: OrderItemModifierInputDto[];
}

// ── Round submission (idempotent per key) ────────────────────
export class SubmitRoundDto {
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];
  /**
   * Idempotency key. A retry of the same submission with the same key must
   * return the existing round rather than creating a duplicate (scenario 11).
   */
  @IsString() @Length(1, 128) idempotencyKey!: string;
  @IsOptional() @IsIn(['DINE_IN', 'TAKEAWAY', 'ONLINE']) channel?: string;
}

// ── Void a sent item ─────────────────────────────────────────
export class VoidItemDto {
  @IsString() @Length(1, 200) reason!: string;
}

// ── Close session (→ Sale) ────────────────────────────────────
export class CloseSessionDto {
  /**
   * Optional idempotency key. A retried close must produce the same Sale, not
   * a duplicate. When absent, the service still refuses a second close because
   * `TableSession.finalSaleId` is `@unique`.
   */
  @IsOptional() @IsString() @Length(1, 128) idempotencyKey?: string;
}
