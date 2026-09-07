import { PaymentMethod } from '@hardware-pos/database';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { ReturnItemInputDto } from '../../returns/dto/return-item-input.dto';
import { SaleItemInputDto } from '../../sales/dto/sale-item.dto';
import { SalePaymentInputDto } from '../../sales/dto/sale-payment.dto';

/**
 * D107 — complete an exchange: return one variant, issue another, settle the
 * difference.
 *
 * The line DTOs are **imported, not redefined**. A returned line is exactly a
 * return line and a replacement line is exactly a sale line; restating either
 * shape here would be a second copy that drifts the first time one of them gains
 * a field — the `4.15` / `4.21` failure in a different costume.
 *
 * **Settlement is gross, not netted** (D107a). The return refunds the goods
 * coming back and the replacement is paid for in full, so `payments` must cover
 * the whole replacement value. For an even swap the customer hands over what
 * they are handed back and the drawer nets to zero.
 *
 * D107 originally netted through `STORE_CREDIT`. That cannot work at a counter:
 * `ReturnsService` refuses a store-credit refund unless the sale has a saved,
 * non-walk-in customer — correctly, because store credit is a liability held
 * against an account — and a clothing shop swapping a size is almost always a
 * walk-in. Gross settlement needs no change to any existing money path.
 */
export class CompleteExchangeDto {
  /** The completed sale the customer is exchanging against. */
  @IsString()
  originalSaleId!: string;

  /** Where the replacement is sold. The return follows the original sale. */
  @IsString()
  branchId!: string;

  @IsString()
  @IsOptional()
  registerId?: string;

  @IsString()
  @IsOptional()
  customerId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemInputDto)
  returnItems!: ReturnItemInputDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleItemInputDto)
  replacementItems!: SaleItemInputDto[];

  /**
   * Tender for the replacement, in FULL — the same payments the till would take
   * if the customer were buying it outright, because that is what is happening.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SalePaymentInputDto)
  payments!: SalePaymentInputDto[];

  /**
   * How the returning leg is refunded. Defaults to `CASH` — the counter case.
   *
   * Whatever is chosen goes through `ReturnsService` unchanged, including its
   * own rules: store credit still demands a saved customer, and a cash refund
   * still cannot exceed what was paid on the original sale.
   */
  @IsEnum(PaymentMethod)
  @IsOptional()
  refundMethod?: PaymentMethod;

  /**
   * Approval token from `POST /returns/approve`.
   *
   * D107: return-approval rules apply unchanged. There is no exchange-specific
   * bypass, because the goods coming back are the same goods either way.
   */
  @IsString()
  @IsOptional()
  approvalToken?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string;

  /**
   * A replay must return the existing exchange rather than refund twice. This
   * matters more here than anywhere else in the system: an exchange moves money
   * in two directions, so a duplicate would refund a customer for goods they
   * kept. Also accepted via the `Idempotency-Key` header.
   */
  @IsString()
  @IsOptional()
  @MaxLength(200)
  idempotencyKey?: string;
}
