import { DiscountBasis, DiscountType } from '@hardware-pos/database';
import { IsEnum, IsNumber, IsOptional, IsPositive, IsString, Min } from 'class-validator';

export class SaleItemInputDto {
  @IsString()
  productId!: string;

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
