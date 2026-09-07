import { DiscountBasis, DiscountType } from '@hardware-pos/database';
import { IsEnum, IsNumber, IsOptional, IsPositive, IsString, MaxLength, Min } from 'class-validator';

/**
 * One line on a quotation. `productId` links a catalog product (its details are
 * snapshotted server-side); omit it for an ad-hoc line, in which case
 * `productName` is required. The server always recomputes money — a client
 * `unitPrice` is only honoured as an override when price overrides are allowed.
 */
export class QuotationItemInputDto {
  @IsString()
  @IsOptional()
  productId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  productName?: string;

  @IsString()
  @IsOptional()
  @MaxLength(80)
  sku?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  @IsString()
  @IsOptional()
  @MaxLength(40)
  unitType?: string;

  /** Price override; used only when quotation price overrides are enabled. */
  @IsNumber()
  @Min(0)
  @IsOptional()
  unitPrice?: number;

  @IsEnum(DiscountType)
  @IsOptional()
  discountType?: DiscountType;

  @IsNumber()
  @Min(0)
  @IsOptional()
  discountValue?: number;

  /**
   * Whether a FIXED amount comes off each unit or the line as a whole. Absent
   * means the line, which is what every quotation before this meant. Rejected on
   * a PERCENTAGE, which is already the same figure either way.
   */
  @IsEnum(DiscountBasis)
  @IsOptional()
  discountBasis?: DiscountBasis;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  itemNote?: string;
}
