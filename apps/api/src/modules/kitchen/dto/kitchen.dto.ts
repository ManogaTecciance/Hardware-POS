import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

const CODE = /^[A-Z][A-Z0-9-]*$/;

export class CreatePrinterDto {
  @IsString() @Length(2, 32) @Matches(CODE, {
    message: 'code must be upper-case alphanumeric with hyphens',
  })
  code!: string;
  @IsString() @Length(1, 80) name!: string;
  @IsIn(['ESC_POS_NETWORK', 'ESC_POS_USB', 'A4_NETWORK', 'MOCK']) kind!: string;
  @IsString() @Length(1, 200) address!: string;
}

export class UpdatePrinterDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsIn(['ESC_POS_NETWORK', 'ESC_POS_USB', 'A4_NETWORK', 'MOCK']) kind?: string;
  @IsOptional() @IsString() @Length(1, 200) address?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class MarkPrintedDto {
  @IsString() @Length(1, 128) printerId!: string;
}

export class MarkFailedDto {
  @IsString() @Length(1, 128) printerId!: string;
  @IsString() @Length(1, 500) error!: string;
}

/**
 * D138 — the ticket history screen's query.
 *
 * Page and size come from the shared pager (1 / 25, capped at 200) so this
 * list behaves like every other list in the product. `search` is bounded the
 * way the sales list bounds its own: a term long enough to be a sentence is a
 * mistake, not a query, and refusing it here beats handing Postgres a
 * megabyte to `ILIKE`.
 */
export class QueryKitchenHistoryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
}
