import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * List filters. `onlyCurrentlyValid` runs the evaluator at request time and
 * therefore requires the evaluation context — `branchId` / `channel` are
 * optional but recommended, and the evaluator will reject a scoped promotion
 * against an absent context by returning false.
 */
export class QueryPromotionsDto {
  @IsString()
  @IsOptional()
  branchId?: string;

  @IsString()
  @IsOptional()
  channel?: string;

  @IsString()
  @IsOptional()
  productId?: string;

  /** class-transformer keeps this as the string 'true' / 'false' — service parses. */
  @IsOptional()
  @IsString()
  isActive?: string;

  @IsOptional()
  @IsString()
  onlyCurrentlyValid?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  limit?: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  offset?: number;
}
