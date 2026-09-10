import { IsNumber, IsOptional, IsPositive } from 'class-validator';

/**
 * D162 — options for `POST /receipts/:saleId/customer`.
 *
 * Every field is optional, and the body may be omitted entirely: the reprint
 * path calls this endpoint with no body at all, and must keep working exactly
 * as it did.
 */
export class CustomerReceiptOptionsDto {
  /**
   * Cash handed over at the till, when it exceeded the total.
   *
   * A RECEIPT fact, not a money fact. It does not change `paidAmount`,
   * `balanceAmount` or the `Payment` row — those describe what settled the
   * sale, and the difference was handed straight back. Recording the tender as
   * the payment would overstate the drawer in the dashboard's payment-method
   * breakdown; recording the change as a balance would put a walk-in customer
   * on the debtors list.
   *
   * Ignored unless it exceeds the total, so an exact-money sale and an
   * under-tender both print as they did before.
   */
  @IsNumber()
  @IsPositive()
  @IsOptional()
  amountTendered?: number;
}
