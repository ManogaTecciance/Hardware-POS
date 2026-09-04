import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { PromotionItemInputDto } from './create-promotion.dto';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * PATCH body. Every field optional; `type` is INTENTIONALLY absent because
 * changing a promotion's type would invalidate the fixedPrice / percentageOff
 * / amountOff semantics baked into every historical PromotionItem. Callers
 * that need a different type must delete + recreate.
 */
export class UpdatePromotionDto {
  @IsString()
  @MaxLength(120)
  @IsOptional()
  name?: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsOptional()
  fixedPrice?: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  percentageOff?: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsOptional()
  amountOff?: number;

  /** D105 — the cart threshold. See `CreatePromotionDto.minimumSpend`. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  minimumSpend?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  buyQuantity?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  getQuantity?: number;

  @IsDateString()
  @IsOptional()
  startsOn?: string;

  @IsDateString()
  @IsOptional()
  endsOn?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  daysOfWeek?: string[];

  @IsString()
  @Matches(HHMM, { message: 'startTime must be HH:MM (24h)' })
  @IsOptional()
  startTime?: string;

  @IsString()
  @Matches(HHMM, { message: 'endTime must be HH:MM (24h)' })
  @IsOptional()
  endTime?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  branchScope?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  channelScope?: string[];

  @IsBoolean()
  @IsOptional()
  stackable?: boolean;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  /**
   * Replace the entire item set. Sent only when the caller actually wants to
   * reshape the promotion's items — undefined leaves them alone.
   *
   * D105 — an empty array is now ACCEPTED here, because clearing the products is
   * how a product-scoped FIXED_AMOUNT_DISCOUNT becomes cart-level. It is not a
   * hole: `update` re-runs `validateTypeShape` over the MERGED state, so
   * emptying a bundle's items still fails, and fails with a message naming the
   * items it needs rather than a generic "should not be empty".
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PromotionItemInputDto)
  @IsOptional()
  items?: PromotionItemInputDto[];
}
