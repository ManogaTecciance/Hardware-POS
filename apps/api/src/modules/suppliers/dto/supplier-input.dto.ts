import {
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Vendor fields exactly as QuickBooks stores them (the Vendor import
 * template). `null` clears a value; `undefined` leaves it untouched.
 */
export class CreateSupplierDto {
  /** Vendor display name — unique per tenant. */
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

  /** Province / Region / State. */
  @IsString()
  @IsOptional()
  @MaxLength(100)
  province?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(40)
  postalCode?: string | null;

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
  taxId?: string | null;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

/** All fields optional — only the provided ones are updated. */
export class UpdateSupplierDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  company?: string | null;

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
  province?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(40)
  postalCode?: string | null;

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
  taxId?: string | null;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
