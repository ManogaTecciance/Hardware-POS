import { DiscountType } from '@hardware-pos/database';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { SaleItemInputDto } from './sale-item.dto';
import { SalePaymentInputDto } from './sale-payment.dto';

/**
 * Complete a sale either by finishing an existing draft (`saleId`) or by passing
 * the full cart in one shot (`branchId` + `items`). `payments` may be empty for
 * a full credit sale.
 */
export class CompleteSaleDto {
  @IsString()
  @IsOptional()
  saleId?: string;

  @ValidateIf((o: CompleteSaleDto) => !o.saleId)
  @IsString()
  branchId?: string;

  @IsString()
  @IsOptional()
  registerId?: string;

  @IsString()
  @IsOptional()
  customerId?: string;

  /**
   * Invoice date, as a `YYYY-MM-DD` calendar date. Omitted = now. Used to record
   * a sale on the day it actually happened; a future date is rejected.
   */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'saleDate must be a YYYY-MM-DD calendar date' })
  @IsOptional()
  saleDate?: string;

  /**
   * When payment is expected, as a `YYYY-MM-DD` calendar date. Required when the
   * sale leaves a balance; rejected on a fully paid sale, which owes nothing.
   */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'paymentDueDate must be a YYYY-MM-DD calendar date' })
  @IsOptional()
  paymentDueDate?: string;

  @ValidateIf((o: CompleteSaleDto) => !o.saleId)
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleItemInputDto)
  items?: SaleItemInputDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalePaymentInputDto)
  payments!: SalePaymentInputDto[];

  // ── Order-level (whole-cart) discount ──────────────────────────────────────

  @IsEnum(DiscountType)
  @IsOptional()
  orderDiscountType?: DiscountType;

  @IsNumber()
  @Min(0)
  @IsOptional()
  orderDiscountValue?: number;

  @IsString()
  @IsOptional()
  orderDiscountReason?: string;

  /** Approval token from POST /discounts/approve for an over-limit order discount. */
  @IsString()
  @IsOptional()
  orderApprovalToken?: string;
}
