import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateBrandDto {
  /**
   * Unique per tenant, enforced by an index rather than by a lookup — two
   * simultaneous "add Nike" requests would both pass a check-then-insert.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

export class UpdateBrandDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  /**
   * Archive or restore. There is no delete: removing a brand would silently
   * unlink every product that used it (D112).
   */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class QueryBrandsDto {
  /**
   * `'true'` (default) lists only brands still stocked; `'false'` only archived
   * ones; omit `includeArchived` entirely for the default.
   *
   * A string rather than a boolean because it arrives in a query string, where
   * `false` and `'false'` are the same three characters and only one of them is
   * falsy.
   */
  @IsOptional()
  @IsString()
  includeArchived?: 'true' | 'false';
}
