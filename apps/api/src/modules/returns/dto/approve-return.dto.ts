import { IsNumber, IsOptional, IsString, Length, Matches, MaxLength, Min } from 'class-validator';

/**
 * A cashier submits a manager's PIN to authorise a high-risk return. Returns a
 * short-lived approval token to attach to the return at completion. Mirrors
 * POST /discounts/approve.
 */
export class ApproveReturnDto {
  @IsString()
  @Length(4, 8)
  @Matches(/^\d+$/, { message: 'managerPin must be numeric' })
  managerPin!: string;

  @IsString()
  originalSaleId!: string;

  /**
   * D102 (4.6) — `@Min(0)`, not `@IsPositive()`.
   *
   * A refund of exactly zero is a real return since promotions: a customer
   * handing back a free buy-two-get-one item is owed nothing, but the goods come
   * back and the stock is restored. `ReturnsService.complete` was widened to
   * accept that in 4.5, and this validator has to agree — otherwise the moment
   * any approval rule fires on a zero-refund return, the manager authorising it
   * would be refused by validation and the return could never complete.
   *
   * Negative is still rejected: money flowing the wrong way is never correct.
   */
  @IsNumber()
  @Min(0)
  refundTotal!: number;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}
