import {
  IsArray,
  IsBoolean,
  IsDateString,
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

/** QuickBooks item types (mirrors the QBO Products & Services template). */
export const PRODUCT_TYPES = ['Inventory', 'NonInventory', 'Service'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/**
 * D45 — Restaurant food-type segmentation. Reuses the D41 `MenuItemType`
 * vocabulary so the wizard, the POS Catalogue endpoint and the historical
 * Restaurant Menu wizard share ONE vocabulary and route through the same
 * category chips.
 */
export const PRODUCT_FOOD_TYPES = ['FOOD', 'BEVERAGE', 'DESSERT'] as const;
export type ProductFoodType = (typeof PRODUCT_FOOD_TYPES)[number];

/**
 * Mirrors the QuickBooks Products & Services fields: name, category, item
 * type, SKU, sales description/price, purchase description/cost, quantity on
 * hand + as-of date, and reorder point. The three QBO account names are
 * auto-resolved during sync — never client input.
 */
export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

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

  /** Sales price/rate. */
  @IsNumber()
  @Min(0)
  unitPrice!: number;

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
   * D101 (3.13) — whether this product attracts tax.
   *
   * Optional on the wire, and ABSENT MEANS TAXABLE. The service defaults it to
   * true, matching the column default and for the same reason: there is no
   * per-product exemption in any tenant's history, so every product already is
   * taxable. A client that omits the field must not silently zero-rate a
   * product.
   */
  @IsBoolean()
  @IsOptional()
  taxable?: boolean;

  /**
   * POS-side product photo, previously uploaded via `POST /products/image` for
   * the Add Product wizard (D44). Kept out of the QuickBooks payload — this is
   * a POS presentation asset, not a QBO field.
   */
  @IsString()
  @IsOptional()
  @MaxLength(2048)
  imageUrl?: string;

  /**
   * D45 — Restaurant Product wizard fields. All optional so Retail flows keep
   * working unchanged; the schema stores them as nullable / defaulted so Tile
   * Shop rows without a backfill remain valid. See `Product` in schema.prisma
   * for the storage decisions.
   */

  /** Kitchen prep time in minutes (KDS ETA hint). */
  @IsInt()
  @Min(0)
  @IsOptional()
  prepMinutes?: number;

  /** Free-form dietary markers (`vegan`, `gluten-free`, `contains-nuts`). */
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  dietaryTags?: string[];

  /** FOOD / BEVERAGE / DESSERT segmentation used by the POS Catalogue. */
  @IsIn(PRODUCT_FOOD_TYPES)
  @IsOptional()
  foodType?: ProductFoodType;

  /**
   * D64 — domain attributes, validated against the tenant descriptor's
   * `catalogue.attributeSchema` by `ProductAttributesService` (the decorator
   * only enforces the container shape; keys and value types are the domain
   * schema's business, not class-validator's).
   */
  @IsObject()
  @IsOptional()
  attributes?: Record<string, unknown>;
}
