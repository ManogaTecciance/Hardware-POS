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

import { PRODUCT_TYPES, type ProductType } from './create-product.dto';

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

  /** POS-side product photo (D44). See CreateProductDto for context. */
  @IsString()
  @IsOptional()
  @MaxLength(2048)
  imageUrl?: string;
}
