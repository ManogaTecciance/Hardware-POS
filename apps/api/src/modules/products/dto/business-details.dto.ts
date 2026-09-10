import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ATTRIBUTE_FIELD_TYPES, type AttributeFieldType } from '@hardware-pos/shared';

/**
 * D150 — `PUT /products/business-details`.
 *
 * Structural rules that are ABOUT the list — duplicate keys, an empty dropdown,
 * a removal that would orphan stored values — live in `BusinessDetailsService`,
 * because they need the other fields or the database to decide. This validates
 * each field on its own.
 */
export class BusinessDetailFieldDto {
  /**
   * The JSON key in `Product.attributes`. Stable: reports address it, and
   * renaming one orphans every value already stored under the old name, which
   * is why the UI offers a rename of the LABEL and never of this.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  key!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  label!: string;

  @IsIn(ATTRIBUTE_FIELD_TYPES)
  type!: AttributeFieldType;

  /** Required at create and on every full replace. */
  @IsOptional()
  required?: boolean;

  /** Dropdown values. Required for `enum`, refused for everything else. */
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  options?: string[];

  /** `text` only — the same cap the domain-declared fields carry. */
  @IsInt()
  @Min(1)
  @IsOptional()
  maxLength?: number;
}

export class ReplaceBusinessDetailsDto {
  /**
   * The whole list, in the order the wizard should render it.
   *
   * Replace semantics, like the attributes document itself: the payload IS the
   * definition. An empty array is a real answer — "we track no business
   * details" — and hides the wizard step; it is not the same as never having
   * configured any, which falls back to the business type's own list.
   */
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => BusinessDetailFieldDto)
  fields!: BusinessDetailFieldDto[];
}
