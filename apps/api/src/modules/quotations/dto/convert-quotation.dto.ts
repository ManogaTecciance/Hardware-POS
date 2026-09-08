import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';

import { SalePaymentInputDto } from '../../sales/dto/sale-payment.dto';

/**
 * Convert an accepted quotation into a sale. With no payments the sale is an
 * unpaid INVOICE (requires a customer); with payments it is a receipt/partial
 * sale. `override` lets an owner-level role re-convert a quotation that already has a
 * linked sale (guards against accidental duplicate conversion).
 */
export class ConvertQuotationDto {
  @IsString()
  @IsOptional()
  branchId?: string;

  @IsString()
  @IsOptional()
  registerId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalePaymentInputDto)
  @IsOptional()
  payments?: SalePaymentInputDto[];

  @IsBoolean()
  @IsOptional()
  override?: boolean;
}
