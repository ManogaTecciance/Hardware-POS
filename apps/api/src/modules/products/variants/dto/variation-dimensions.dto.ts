import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * PUT /products/:productId/variations — the wizard's dimensions declaration.
 *
 * Deliberately structural, not incremental: the client posts the *full* target
 * shape and the service upserts + prunes to converge to it. That keeps the UI
 * free from three-way diffing and matches how the Restaurant menu wizard
 * declares its modifier groups (D41). Matching is by `name`, so renaming a
 * dimension is a delete + create — safe because the delete refuses to run when
 * any variant is bound to it, so the wizard cannot silently orphan a variant.
 */

export class VariationOptionInputDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  position?: number;
}

export class VariationDimensionInputDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  position?: number;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => VariationOptionInputDto)
  options!: VariationOptionInputDto[];
}

export class ReplaceVariationsDto {
  // An empty `dimensions` array is allowed: it is how a wizard "clears
  // variations" on a product that never actually created any variants. The
  // service still refuses to prune a dimension/option any variant references.
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariationDimensionInputDto)
  dimensions!: VariationDimensionInputDto[];
}
