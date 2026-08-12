import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * POST /products/:productId/variants:batch — the wizard's final step.
 *
 * A single request creates every enabled variant on a product so the wizard's
 * commit is one round-trip and one transaction. Opening quantity is optional
 * per row; when set for a LOCAL tenant, the service routes it through the same
 * `InventoryProvider.receiveStock` pipeline as a future GRN, so first-time
 * stock and later stock share ONE weighted-average path (D44). Non-LOCAL
 * tenants must instead receive stock after creation or push it via QuickBooks.
 */

export class VariantOptionValueInputDto {
  @IsString()
  @IsNotEmpty()
  dimensionId!: string;

  @IsString()
  @IsNotEmpty()
  optionId!: string;
}

export class CreateVariantInputDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  sku!: string;

  @IsString()
  @IsOptional()
  @MaxLength(80)
  barcode?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  costPrice?: number;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @IsOptional()
  reorderLevel?: number;

  /**
   * If > 0 on a LOCAL tenant, the service creates an opening `InventoryReceipt`
   * and calls `receiveStock` so weighted-average is seeded on the same path as
   * future receipts. Reject on non-LOCAL tenants — QuickBooks or DISABLED
   * modes do not own local stock movement.
   */
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @IsOptional()
  openingQuantity?: number;

  @IsString()
  @IsOptional()
  imageUrl?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  /**
   * D46 — one variant per product may be marked `isDefault=true`. The POS
   * Counter's Customise dialog preselects it. The schema-level partial
   * unique index (`ProductVariant_productId_default_key`) guarantees at
   * most one; if the batch flags two the transaction fails at the DB.
   */
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @IsInt()
  @Min(0)
  @Max(10000)
  @IsOptional()
  position?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariantOptionValueInputDto)
  optionValues!: VariantOptionValueInputDto[];
}

export class CreateVariantBatchDto {
  /**
   * Explicit `branchId` for opening receipts: opening stock has to land in ONE
   * specific branch, and inferring "the tenant's only branch" would silently
   * misbehave the moment a second branch is added. Optional — omit when no
   * variant carries a positive `openingQuantity`.
   */
  @IsString()
  @IsOptional()
  openingBranchId?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateVariantInputDto)
  variants!: CreateVariantInputDto[];
}
