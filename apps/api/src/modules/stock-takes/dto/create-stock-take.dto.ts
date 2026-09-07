import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One counted line.
 *
 * `countedQuantity` is what is physically on the shelf — an assertion, not a
 * correction. The server works out the variance against what the books said at
 * the moment of the count, so a client cannot send a delta computed from a stale
 * read and have it applied to a number that has since moved.
 */
export class StockTakeLineDto {
  @IsString()
  productId!: string;

  /** Omitted for a product sold without variants. */
  @IsOptional()
  @IsString()
  productVariantId?: string;

  /** 3dp, like every other quantity. Zero is a legitimate count: "none left". */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  countedQuantity!: number;
}

export class CreateStockTakeDto {
  @IsString()
  branchId!: string;

  /**
   * At least one line — a count of nothing is not a count, and recording one
   * would put an empty document in the history for someone to puzzle over.
   *
   * Capped at 500: a cycle count is a section of a shop, and a request larger
   * than this is a full stock take that belongs in several submissions, each
   * with its own audit trail.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => StockTakeLineDto)
  lines!: StockTakeLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /**
   * A double-submitted count form must not post the correction twice.
   *
   * Enforced by a unique index on `(tenantId, idempotencyKey)` rather than by a
   * check-then-write, which two simultaneous submissions would both pass.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;
}
