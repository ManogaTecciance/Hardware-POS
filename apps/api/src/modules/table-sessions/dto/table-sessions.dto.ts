import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * D46 — source discriminator on a round item. Mirrors the Prisma enum
 * `RestaurantOrderItemSourceKind` (kept as a local string enum so the DTO
 * layer does not pull the generated Prisma runtime into request validation).
 * `MENU_ITEM` is the legacy default so clients that don't send `sourceKind`
 * keep their existing behaviour verbatim.
 */
export enum RestaurantOrderItemSourceKindDto {
  MENU_ITEM = 'MENU_ITEM',
  PRODUCT = 'PRODUCT',
}

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
  /**
   * D46 — which authority the round item was sourced from. Omitted or
   * `MENU_ITEM` keeps the legacy path (menuItemId lookup); `PRODUCT`
   * routes to the Product + optional ProductVariant resolver added in
   * D46. Nullable-defaulted at the DTO layer so historical clients stay
   * valid — the service treats a missing discriminator as `MENU_ITEM`.
   */
  @IsOptional() @IsEnum(RestaurantOrderItemSourceKindDto)
  sourceKind?: RestaurantOrderItemSourceKindDto;

  /**
   * Legacy MENU_ITEM path — the MenuItem id whose name / basePrice the
   * service snapshots. Required when `sourceKind` is `MENU_ITEM` (or
   * omitted). Kept as a distinct field from `productId` on the wire so
   * a client cannot accidentally send a Product id under the MenuItem
   * discriminator (or vice versa) and have the service silently accept
   * the wrong shape.
   */
  @ValidateIf((o: OrderItemInputDto) =>
    (o.sourceKind ?? RestaurantOrderItemSourceKindDto.MENU_ITEM) ===
    RestaurantOrderItemSourceKindDto.MENU_ITEM,
  )
  @IsString() @Length(1, 128)
  menuItemId?: string;

  /**
   * D46 PRODUCT path — the Product id whose (variant?) unitPrice the
   * service snapshots. Required when `sourceKind === 'PRODUCT'`.
   */
  @ValidateIf(
    (o: OrderItemInputDto) => o.sourceKind === RestaurantOrderItemSourceKindDto.PRODUCT,
  )
  @IsString() @Length(1, 128)
  productId?: string;

  /**
   * D46 PRODUCT path — the ProductVariant id when the Product carries
   * variants. Optional at the DTO layer because a non-variant Product
   * is legitimately sent without one; the service still refuses a
   * missing variantId when the Product has any active variants (that
   * is a service-layer decision because the answer depends on data,
   * not the request shape).
   */
  @IsOptional() @IsString() @Length(1, 128)
  productVariantId?: string;

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
  /**
   * D52 — the till that took the money. Optional: absent one the branch's
   * first active register by code is used, which is deterministic where the
   * previous unordered findFirst was not.
   */
  @IsOptional() @IsString() registerId?: string;
}
