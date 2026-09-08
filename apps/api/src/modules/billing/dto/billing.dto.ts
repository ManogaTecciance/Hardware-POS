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
  /**
   * D51 — allocate this tender to one split ("Alex pays his own bill").
   * Omitted, the payment lands against the whole sale as before.
   */
  @IsOptional() @IsString() splitId?: string;
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

// ── D51 — item-level splitting ────────────────────────────────
//
// `share` is deliberately absent: on this path the server derives it from the
// assigned lines plus a pro-rata slice of the sale's other charges. An
// operator-supplied amount here would be a second, conflicting authority.

export class SplitItemAssignmentDto {
  @IsString() orderItemId!: string;
  /** Portion of that line this split covers; 3 decimals like the line itself. */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) quantity!: number;
}

export class ItemSplitInputDto {
  @IsOptional() @IsString() @Length(1, 80) label?: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => SplitItemAssignmentDto)
  items!: SplitItemAssignmentDto[];
}

export class SplitByItemsDto {
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ItemSplitInputDto)
  splits!: ItemSplitInputDto[];
}
