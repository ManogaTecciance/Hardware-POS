import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { PRODUCT_TYPES, type ProductType } from './create-product.dto';

/**
 * One reviewed row sent back from the client to be committed. Mirrors the
 * preview's ParsedProductRow (the client may have adjusted nothing but images).
 * rowNumber is echoed back in the result so the client can map created product
 * ids to the images it holds for each row.
 */
export class ImportProductRowDto {
  @IsInt()
  rowNumber!: number;

  /**
   * D168 — the tenant's business details (D150) read from the sheet.
   *
   * Round-tripped from the preview rather than re-read, so the rows the
   * operator reviewed are the rows that are written.
   *
   * OPTIONAL and never defaulted to `{}`: D64 gives the document replace
   * semantics, so an empty object on an update erases what the product
   * holds. Absent means the sheet said nothing about these fields.
   */
  @IsObject()
  @IsOptional()
  attributes?: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsIn(PRODUCT_TYPES)
  type!: ProductType;

  @IsString()
  @IsOptional()
  @MaxLength(80)
  sku?: string | null;

  /** Raw "Parent:Sub" category path; created on commit. */
  @IsString()
  @IsOptional()
  categoryPath?: string | null;

  @IsString()
  @IsOptional()
  description?: string | null;

  @IsNumber()
  @Min(0)
  unitPrice!: number;

  @IsString()
  @IsOptional()
  purchaseDescription?: string | null;

  @IsNumber()
  @Min(0)
  @IsOptional()
  costPrice?: number | null;

  @IsNumber()
  @Min(0)
  @IsOptional()
  quantityOnHand?: number | null;

  @IsString()
  @IsOptional()
  quantityAsOfDate?: string | null;

  @IsNumber()
  @Min(0)
  @IsOptional()
  reorderLevel?: number | null;

  @IsString()
  @IsOptional()
  incomeAccount?: string | null;

  @IsString()
  @IsOptional()
  expenseAccount?: string | null;

  @IsString()
  @IsOptional()
  inventoryAssetAccount?: string | null;

  // Preview-only fields the client echoes back; accepted but ignored on commit.
  @IsIn(['create', 'update'])
  @IsOptional()
  matchStatus?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  errors?: string[];
}

export class CommitImportDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => ImportProductRowDto)
  rows!: ImportProductRowDto[];
}
