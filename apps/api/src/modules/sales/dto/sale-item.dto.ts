import { DiscountBasis, DiscountType } from '@hardware-pos/database';
import { IsEnum, IsNumber, IsOptional, IsPositive, IsString, Min } from 'class-validator';

export class SaleItemInputDto {
  @IsString()
  productId!: string;

  /**
   * D120 — the exact variant sold, for a product that has variants.
   *
   * Optional because most sellable things do not have one: loose goods, a
   * service, a single-SKU product. `SaleItem.productVariantId` is nullable for
   * the same reason (D44), and history predates variants entirely.
   *
   * Ownership is validated server-side — the variant must belong to `productId`
   * and be active. A client cannot pair someone else's variant with a product it
   * does not belong to.
   */
  @IsString()
  @IsOptional()
  productVariantId?: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  /** Optional price echo from the client; validated against the cached price. */
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
   * Whether `discountValue` comes off each unit or the line as a whole. Absent
   * means the line as a whole, which is what every sale before this meant.
   *
   * Only meaningful with a FIXED discount; pairing UNIT with a PERCENTAGE is
   * rejected at completion, where the discount is computed.
   */
  @IsEnum(DiscountBasis)
  @IsOptional()
  discountBasis?: DiscountBasis;

  @IsString()
  @IsOptional()
  discountReason?: string;

  /** Approval token from POST /discounts/approve, required for over-limit discounts. */
  @IsString()
  @IsOptional()
  approvalToken?: string;
}
