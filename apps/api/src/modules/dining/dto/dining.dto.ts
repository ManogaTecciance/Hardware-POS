import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

const TABLE_CODE = /^[A-Z0-9][A-Z0-9-]*$/;

// ── Dining area ─────────────────────────────────────────────
export class CreateDiningAreaDto {
  @IsString() @Length(1, 80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
}

export class UpdateDiningAreaDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// ── Restaurant table ─────────────────────────────────────────
export class CreateTableDto {
  @IsString() @Length(1, 32) @Matches(TABLE_CODE, {
    message: 'code must be upper-case alphanumeric with hyphens',
  })
  code!: string;
  @IsOptional() @IsString() @Length(1, 80) label?: string;
  @Type(() => Number) @IsInt() @Min(1) capacity!: number;
  @IsOptional() @Type(() => Number) @IsInt() positionX?: number;
  @IsOptional() @Type(() => Number) @IsInt() positionY?: number;
}

export class UpdateTableDto {
  @IsOptional() @IsString() @Length(1, 80) label?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) capacity?: number;
  @IsOptional() @Type(() => Number) @IsInt() positionX?: number;
  @IsOptional() @Type(() => Number) @IsInt() positionY?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsIn(['AVAILABLE', 'SEATED', 'OCCUPIED', 'BILLING', 'CLEANING', 'BLOCKED'])
  status?: string;
}
