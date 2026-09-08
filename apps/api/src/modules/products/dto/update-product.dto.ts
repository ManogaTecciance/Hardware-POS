import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { QuantityType } from '@hardware-pos/database';

import {
  PRODUCT_FOOD_TYPES,
  PRODUCT_TYPES,
  type ProductFoodType,
  type ProductType,
} from './create-product.dto';

/** All fields optional — only the provided ones are updated. */
export class UpdateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsOptional()
  name?: string;

  @IsIn(PRODUCT_TYPES)
  @IsOptional()
  type?: ProductType;

  @IsString()
  @IsOptional()
  @MaxLength(80)
  sku?: string;

  /** Sales description — appears on sales forms and receipts. */
  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  categoryId?: string;

  @IsString()
  @IsOptional()
  subcategoryId?: string;

  /**
   * D133 (`8.9`) — the brand this product carries.
   *
   * Three states, all meaningful: absent leaves the stored brand alone, `''`
   * clears it, and an id sets it. A DTO that could only set or clear would make
   * every partial update from a wizard step wipe the brand.
   */
  @IsString()
  @IsOptional()
  brandId?: string;

  /**
   * D134 (`6.1`) — sold by the piece, or by weight/measure.
   *
   * Omitted means `WHOLE`, which is what every product was before this
   * existed. A client that has never heard of measured goods keeps working.
   */
  @IsEnum(QuantityType)
  @IsOptional()
  quantityType?: QuantityType;

  /**
   * D134b — what the quantity is measured in: `kg`, `g`, `L`.
   *
   * **Required when `quantityType` is `DECIMAL`** — enforced in
   * `ProductsService` against the RESULTING state, not here, because the
   * rule is conditional on another field and a DTO cannot see the stored row
   * (D134c).
   */
  @IsString()
  @IsOptional()
  @MaxLength(16)
  unitOfMeasure?: string;

  /** Sales price/rate. */
  @IsNumber()
  @Min(0)
  @IsOptional()
  unitPrice?: number;

  /** Purchase description — what vendors see on purchase forms. */
  @IsString()
  @IsOptional()
  purchaseDescription?: string;

  /** Purchase cost. */
  @IsNumber()
  @Min(0)
  @IsOptional()
  costPrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  quantityOnHand?: number;

  /** The date the quantity on hand was counted (QBO "Quantity as of date"). */
  @IsDateString()
  @IsOptional()
  quantityAsOfDate?: string;

  /** Reorder point. */
  @IsNumber()
  @Min(0)
  @IsOptional()
  reorderLevel?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  /**
   * D122 (3.13) — whether this product attracts tax. Undefined leaves the
   * stored value alone, so a partial update cannot make a product exempt by
   * omission; only an explicit boolean moves it.
   */
  @IsBoolean()
  @IsOptional()
  taxable?: boolean;

  /** POS-side product photo (D44). See CreateProductDto for context. */
  @IsString()
  @IsOptional()
  @MaxLength(2048)
  imageUrl?: string;

  /**
   * D45 — Restaurant Product wizard fields. See CreateProductDto for the
   * per-field notes. Update semantics: `undefined` = leave unchanged; an
   * explicit `null` on `prepMinutes` / `foodType` clears the column, and an
   * empty `dietaryTags` array clears the tag list.
   */
  @IsInt()
  @Min(0)
  @IsOptional()
  prepMinutes?: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  dietaryTags?: string[];

  @IsIn(PRODUCT_FOOD_TYPES)
  @IsOptional()
  foodType?: ProductFoodType;

  /**
   * D64 — domain attributes. REPLACE semantics when provided (the payload is
   * the whole document — required keys are re-checked); `undefined` leaves
   * the stored document unchanged. See CreateProductDto.
   */
  @IsObject()
  @IsOptional()
  attributes?: Record<string, unknown>;
}
