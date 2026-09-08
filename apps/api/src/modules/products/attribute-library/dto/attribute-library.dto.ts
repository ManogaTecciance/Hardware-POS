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
 * D125 / D125a — the tenant option library's write shape.
 *
 * NOT `Product.attributes` (D64, `product-attributes.service.ts`), which
 * validates a domain's declared catalogue fields. Two different things one word
 * apart in the same module: this one is the reusable Size/Colour scales a
 * product's own dimensions point at.
 *
 * Structural like the variations DTO next door: the client posts the full
 * target list of options and the service converges to it. Matching is by
 * `code`, because `code` is what a generated SKU carries — renaming an option
 * keeps its SKU segment, changing its code does not, and the second one has to
 * be a deliberate act.
 */

export class AttributeOptionInputDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  /**
   * Free-form here, normalised and validated by the service against the shared
   * rule. Deliberately not a `@Matches` regex: the message an operator sees
   * comes from `attributeCodeIssue()` so the API and the form's live preview
   * cannot disagree about why a code was refused.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  code!: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  position?: number;

  /** `#RRGGBB`. Validated by the service via the shared rule. */
  @IsString()
  @IsOptional()
  @MaxLength(7)
  swatchHex?: string | null;
}

export class CreateAttributeDefinitionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  position?: number;

  /**
   * D125a — the binding hint. Nullable: an unbound definition applies to every
   * category. Never enforcement; nothing refuses a product in another category.
   */
  @IsString()
  @IsOptional()
  categoryId?: string | null;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => AttributeOptionInputDto)
  options!: AttributeOptionInputDto[];
}

export class UpdateAttributeDefinitionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @IsOptional()
  name?: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  position?: number;

  @IsString()
  @IsOptional()
  categoryId?: string | null;

  /**
   * Omit to leave the option set untouched; send it to replace the set
   * wholesale. An empty array is refused — a definition with no options is a
   * scale that cannot be used, and silently allowing it produces a picker with
   * nothing in it and no explanation.
   */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => AttributeOptionInputDto)
  @IsOptional()
  options?: AttributeOptionInputDto[];
}
