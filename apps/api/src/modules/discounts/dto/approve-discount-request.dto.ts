import { DiscountBasis, DiscountType } from '@hardware-pos/database';
import { IsEnum, IsNumber, IsOptional, IsString, Length, Matches, IsPositive } from 'class-validator';

export class ApproveDiscountRequestDto {
  @IsString()
  @Length(4, 8)
  @Matches(/^\d+$/, { message: 'managerPin must be numeric' })
  managerPin!: string;

  @IsString()
  productId!: string;

  @IsEnum(DiscountType)
  discountType!: DiscountType;

  @IsNumber()
  @IsPositive()
  discountValue!: number;

  /** Whether the amount is per unit or for the line; bound into the token. */
  @IsEnum(DiscountBasis)
  @IsOptional()
  discountBasis?: DiscountBasis;

  @IsString()
  @IsOptional()
  reason?: string;
}
