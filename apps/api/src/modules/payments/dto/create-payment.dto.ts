import { PaymentMethod } from '@hardware-pos/database';
import { IsEnum, IsNumber, IsString, IsOptional, Min } from 'class-validator';

/**
 * A payment received against a customer's CREDIT ACCOUNT.
 *
 * There is deliberately no `saleId`: credit is settled per account, so money is
 * never applied to one invoice. Payments tendered at the till are created with
 * the sale itself and never come through here.
 */
export class CreatePaymentDto {
  @IsString()
  customerId!: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsString()
  @IsOptional()
  reference?: string;
}
