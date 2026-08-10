import { Type } from 'class-transformer';
import {
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
//
// Neither Create nor Update accepts `createdByUserId` — the field is a
// server-side attribution and would be a spoofing vector if the DTO named it.
// Neither accepts `isActive` — archive is its own endpoint with its own
// conflict rules (an area with active tables cannot be archived); a silent
// isActive flip through PATCH would bypass those checks.

export class CreateDiningAreaDto {
  @IsString() @Length(1, 80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
}

export class UpdateDiningAreaDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) position?: number;
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

/**
 * The creator-scoped edit DTO. It does NOT accept `isActive` (that is
 * archive) or `status` (operational state, driven by sessions).
 * `code` is intentionally absent too — code is the unique operator-facing
 * label callers rely on out loud, and renaming it in-flight breaks the
 * shared vocabulary; a re-issue is a new table.
 */
export class UpdateTableDto {
  @IsOptional() @IsString() @Length(1, 80) label?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) capacity?: number;
  @IsOptional() @Type(() => Number) @IsInt() positionX?: number;
  @IsOptional() @Type(() => Number) @IsInt() positionY?: number;
}
