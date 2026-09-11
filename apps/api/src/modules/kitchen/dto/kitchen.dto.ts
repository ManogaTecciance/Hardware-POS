import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
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
  /** `host:port` for a network printer (port defaults to 9100), else a device path. */
  @IsString() @Length(1, 200) address!: string;
  /** D174 — KITCHEN (station-routed KOTs) or CASHIER (bills). */
  @IsOptional() @IsIn(['KITCHEN', 'CASHIER']) role?: string;
  /** D174 — characters per line: 48 = 80 mm paper, 32 = 58 mm. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(24) @Max(96) columns?: number;
}

export class UpdatePrinterDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsIn(['ESC_POS_NETWORK', 'ESC_POS_USB', 'A4_NETWORK', 'MOCK']) kind?: string;
  @IsOptional() @IsString() @Length(1, 200) address?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsIn(['KITCHEN', 'CASHIER']) role?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(24) @Max(96) columns?: number;
}

/**
 * D174 — which stations a printer serves. Replace-all: the body IS the set,
 * which is how the settings screen edits it (tick the stations, save).
 * A KITCHEN printer with no links still prints when it is the branch's
 * default kitchen printer; otherwise it prints nothing, because KOT attempts
 * are created per station→printer link.
 */
export class SetPrinterStationsDto {
  @IsArray() @IsString({ each: true }) stationIds!: string[];
  /** The station's primary printer (the one the ticket records). Default true. */
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class MarkPrintedDto {
  @IsString() @Length(1, 128) printerId!: string;
}

export class MarkFailedDto {
  @IsString() @Length(1, 128) printerId!: string;
  @IsString() @Length(1, 500) error!: string;
}

/**
 * D142 — the ticket history screen's query.
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
