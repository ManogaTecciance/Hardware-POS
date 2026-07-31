import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { ROLL_PROFILES, type RollKey } from '../roll-profiles';

export const ROLL_KEYS = Object.keys(ROLL_PROFILES) as RollKey[];

export class LabelLineDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  /** Stickers to print for this product. */
  @IsInt()
  @Min(1)
  @Max(1000)
  copies = 1;
}

export class PrintLabelsDto {
  @IsIn(ROLL_KEYS)
  roll!: RollKey;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => LabelLineDto)
  lines!: LabelLineDto[];

  /** Printer head resolution; 203 for a stock ZD888TA. */
  @IsInt()
  @IsIn([203, 300])
  @IsOptional()
  dpi?: number;

  /** Skip N sticker slots so a part-used roll isn't wasted. */
  @IsInt()
  @Min(0)
  @Max(10)
  @IsOptional()
  startOffset?: number;

  /** ^MD burn adjustment. */
  @IsInt()
  @Min(-30)
  @Max(30)
  @IsOptional()
  darkness?: number;

  /** Encode a QR symbol instead of a 1D barcode. */
  @IsBoolean()
  @IsOptional()
  qr?: boolean;
}
