import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * PATCH /products/:productId/variants/:variantId — mutable, safe fields only.
 *
 * The DTO deliberately omits `optionValues` and `quantityOnHand`:
 *
 *  • Changing option values changes variant *identity* — the pair
 *    `(dimension, option)` per variant is the key sale/return/menu snapshots
 *    are built against. A rename would rewrite history, so the wizard has to
 *    delete + create instead.
 *  • Stock never changes here. `POST /inventory-receipts` is the ONE writer
 *    for on-hand quantities and weighted-average cost (D44).
 */
export class UpdateVariantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @IsOptional()
  sku?: string;

  @IsString()
  @IsOptional()
  @MaxLength(80)
  barcode?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  unitPrice?: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  costPrice?: number;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @IsOptional()
  reorderLevel?: number;

  @IsString()
  @IsOptional()
  imageUrl?: string;

  @IsInt()
  @Min(0)
  @Max(10000)
  @IsOptional()
  position?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
