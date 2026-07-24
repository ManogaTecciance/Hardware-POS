import { CustomerType } from '@hardware-pos/database';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** All fields optional — only the provided ones are updated. */
export class UpdateCustomerDto {
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
  @MaxLength(100)
  qbCustomerType?: string | null;

  @IsEmail()
  @IsOptional()
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

  @IsEnum(CustomerType)
  @IsOptional()
  customerType?: CustomerType;

  @IsBoolean()
  @IsOptional()
  creditAllowed?: boolean;

  @IsNumber()
  @Min(0)
  @IsOptional()
  creditLimit?: number | null;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
