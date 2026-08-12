import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** QuickBooks item types (mirrors the QBO Products & Services template). */
export const PRODUCT_TYPES = ['Inventory', 'NonInventory', 'Service'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

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
   * POS-side product photo, previously uploaded via `POST /products/image` for
   * the Add Product wizard (D44). Kept out of the QuickBooks payload — this is
   * a POS presentation asset, not a QBO field.
   */
  @IsString()
  @IsOptional()
  @MaxLength(2048)
  imageUrl?: string;
}
