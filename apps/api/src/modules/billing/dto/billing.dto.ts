import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CollectPaymentDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount!: number;
  @IsIn(['CASH', 'CARD', 'BANK_TRANSFER', 'QR_PAYMENT', 'CHECK', 'STORE_CREDIT', 'OTHER'])
  method!: string;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
}

export class BillSplitInputDto {
  @IsOptional() @IsString() @Length(1, 80) label?: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) share!: number;
}

export class CreateSplitsDto {
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => BillSplitInputDto)
  splits!: BillSplitInputDto[];
}

export class ReopenBillDto {
  @IsString() @Length(1, 200) reason!: string;
}
