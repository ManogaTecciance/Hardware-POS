import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * POST /inventory-receipts — the Receive Stock / GRN form.
 *
 * A single request writes one immutable receipt (header + lines) and moves
 * stock through the tenant's `InventoryProvider`. Idempotency is optional but
 * strongly recommended for any UI whose Submit button could double-fire — the
 * unique index on `(tenantId, idempotencyKey)` catches a same-key retry and
 * returns the original receipt rather than creating a second one.
 */

export class ReceiptLineInputDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  /**
   * NULL for a legacy variant-less product. Set for every variant product —
   * the service validates that the variant actually belongs to the product.
   */
  @IsString()
  @IsOptional()
  productVariantId?: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  quantityReceived!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitCost!: number;

  @IsString()
  @IsOptional()
  @MaxLength(80)
  lotNumber?: string;

  @IsDateString()
  @IsOptional()
  expiryDate?: string;
}

export class CreateReceiptDto {
  @IsString()
  @IsNotEmpty()
  branchId!: string;

  @IsString()
  @IsOptional()
  supplierId?: string;

  @IsDateString()
  @IsOptional()
  receivedAt?: string;

  @IsString()
  @IsOptional()
  @MaxLength(80)
  invoiceReference?: string;

  @IsString()
  @IsOptional()
  @MaxLength(80)
  grnReference?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  notes?: string;

  /**
   * Free-form idempotency token, opaque to the server. Deliberately not
   * generated for the client: the browser knows better than we do when it is
   * retrying a request that already committed.
   */
  @IsString()
  @IsOptional()
  @MaxLength(120)
  idempotencyKey?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ReceiptLineInputDto)
  lines!: ReceiptLineInputDto[];
}
