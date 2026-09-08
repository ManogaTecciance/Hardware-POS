import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * D90 — opening hours, in minutes since LOCAL midnight.
 *
 * `closesAt` is allowed past 1440 so a kitchen that shuts at 01:00 can say
 * 1500 rather than 60, which would read as closing an hour after midnight
 * *yesterday*. The ceiling is 30:00 (1800): later than that and the operator
 * has almost certainly typed a duration rather than a closing time.
 */
export const MIN_OF_DAY = 0;
export const MAX_OPEN_MINUTE = 1439;
export const MAX_CLOSE_MINUTE = 1800;

export class OpeningHoursDayDto {
  /** 0 = Sunday … 6 = Saturday, matching `Date.getDay()`. */
  @Type(() => Number) @IsInt() @Min(0) @Max(6) dayOfWeek!: number;

  @IsOptional() @IsBoolean() isClosed?: boolean;

  @Type(() => Number) @IsInt() @Min(MIN_OF_DAY) @Max(MAX_OPEN_MINUTE) opensAt!: number;

  @Type(() => Number) @IsInt() @Min(1) @Max(MAX_CLOSE_MINUTE) closesAt!: number;
}

export class OpeningHoursOverrideDto {
  /** Local calendar date, `YYYY-MM-DD`. Not an ISO timestamp — see D90. */
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @IsOptional() @IsBoolean() isClosed?: boolean;

  @Type(() => Number) @IsInt() @Min(MIN_OF_DAY) @Max(MAX_OPEN_MINUTE) opensAt!: number;

  @Type(() => Number) @IsInt() @Min(1) @Max(MAX_CLOSE_MINUTE) closesAt!: number;

  /** Why this date is different, in the owner's words. */
  @IsOptional() @IsString() @MaxLength(120) note?: string;
}

/**
 * A whole-schedule replacement. Not a patch: the owner edits the week as a
 * unit in Settings, and a partial update would need a delete verb for the
 * weekday they just switched back to "same as usual".
 */
export class UpdateOpeningHoursDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OpeningHoursDayDto)
  weekly!: OpeningHoursDayDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OpeningHoursOverrideDto)
  overrides!: OpeningHoursOverrideDto[];
}
