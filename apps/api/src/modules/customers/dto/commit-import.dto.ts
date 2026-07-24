import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * One reviewed customer row sent back from the client to be committed. Mirrors
 * the preview's ParsedCustomerRow; `matchStatus`/`errors` are echoes of the
 * preview response, accepted but ignored.
 */
export class ImportCustomerRowDto {
  @IsInt()
  rowNumber!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  company?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  qbCustomerType?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  email?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(40)
  phone?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(40)
  mobile?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(40)
  fax?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  website?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  street?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  city?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  state?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(40)
  zip?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  country?: string | null;

  @IsNumber()
  @IsOptional()
  openingBalance?: number | null;

  @IsDateString()
  @IsOptional()
  openingBalanceDate?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(60)
  resaleNumber?: string | null;

  // Preview echoes tolerated from the client (ignored).
  @Allow()
  matchStatus?: unknown;

  @Allow()
  errors?: unknown;
}

export class CommitCustomerImportDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => ImportCustomerRowDto)
  rows!: ImportCustomerRowDto[];
}
