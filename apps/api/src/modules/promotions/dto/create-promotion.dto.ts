import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * D45 — Promotion vocabulary. String unions rather than Prisma enums so the
 * DTO stays decoupled from the generated client (which is only available at
 * runtime after `db:generate`) and so validation errors read the vocabulary
 * back to the client verbatim.
 */
export const PROMOTION_TYPES = [
  'BUNDLE_FIXED_PRICE',
  'BUY_X_GET_Y',
  'PERCENTAGE_DISCOUNT',
  'FIXED_AMOUNT_DISCOUNT',
] as const;
export type PromotionTypeValue = (typeof PROMOTION_TYPES)[number];

export const PROMOTION_ITEM_ROLES = ['BUY', 'GET', 'BUNDLE'] as const;
export type PromotionItemRoleValue = (typeof PROMOTION_ITEM_ROLES)[number];

export class PromotionItemInputDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsIn(PROMOTION_ITEM_ROLES)
  role!: PromotionItemRoleValue;

  /** Quantity of this line the promotion touches (BUY count, GET count, or
   *  BUNDLE-piece count). Defaults to 1 to match the schema default. */
  @IsInt()
  @Min(1)
  @IsOptional()
  quantity?: number;
}

export class CreatePromotionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @IsIn(PROMOTION_TYPES)
  type!: PromotionTypeValue;

  /** BUNDLE_FIXED_PRICE — collapsed final price. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsOptional()
  fixedPrice?: number;

  /** PERCENTAGE_DISCOUNT / BUY_X_GET_Y — 0-100. Service enforces the range
   *  per type (BUY_X_GET_Y allows 0 = free wearing an amountOff; the
   *  percentage path requires >0). */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  percentageOff?: number;

  /** FIXED_AMOUNT_DISCOUNT — money off. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsOptional()
  amountOff?: number;

  /**
   * D105 — FIXED_AMOUNT_DISCOUNT only. The eligible cart amount the basket must
   * reach before the discount applies. Omitted means no threshold.
   *
   * `@Min(0)` rather than `@Min(0.01)`: an explicit 0 is a meaningful way to say
   * "no minimum", and refusing it would make the editor's empty-field and
   * zero-field cases behave differently for no reason.
   */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  minimumSpend?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  buyQuantity?: number;

  @IsInt()
  @Min(1)
  @IsOptional()
  getQuantity?: number;

  @IsDateString()
  @IsOptional()
  startsOn?: string;

  @IsDateString()
  @IsOptional()
  endsOn?: string;

  /** Values must be from `MenuAvailabilityDayOfWeek`; validated at service
   *  level rather than at class-validator time so a new day-of-week symbol
   *  doesn't force a DTO edit. */
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

  /** `RestaurantOrderChannel` names, service-checked. */
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  channelScope?: string[];

  @IsBoolean()
  @IsOptional()
  stackable?: boolean;

  /*
   * D105 — no `@ArrayNotEmpty()`. An EMPTY item list is how a
   * FIXED_AMOUNT_DISCOUNT declares itself cart-level. Every other type still
   * requires its items, but that is enforced by `validateTypeShape`, which can
   * say which items are missing and why; a blanket decorator here could only
   * say "should not be empty" and would refuse a shape that is now valid.
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PromotionItemInputDto)
  items!: PromotionItemInputDto[];
}
