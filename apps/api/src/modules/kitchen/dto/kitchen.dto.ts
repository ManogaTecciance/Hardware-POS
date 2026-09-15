import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  /** D181 — KITCHEN (station-routed KOTs) or CASHIER (bills). */
  @IsOptional() @IsIn(['KITCHEN', 'CASHIER']) role?: string;
  /** D181 — characters per line: 48 = 80 mm paper, 32 = 58 mm. */
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
 * D181 — which stations a printer serves. Replace-all: the body IS the set,
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
 * D174 — the optional station a board read is pinned to.
 *
 * On `GET …/kitchen-tickets/counts` this is the whole query. A plain bounded
 * string, not an id the pipe checks against the branch's stations: an id that
 * names no station of this branch scopes the read to nothing and answers with
 * empty lists and zero counts, which is the truth about that station here,
 * and a board whose selected station was archived mid-shift gets zeros rather
 * than a 400 it cannot recover from. Empty is treated as omitted by the
 * service, the way a blank search is.
 */
export class QueryKitchenLaneCountsDto {
  @IsOptional() @IsString() @MaxLength(128) stationId?: string;
  /**
   * D200 — the board's search, server-side, on the list AND the counts. The
   * same three legs the history search has (ticket number, order number or
   * call number, dish), bounded the same way (D142's 120), and on this DTO
   * rather than the tickets one so a station cut's counts read narrows with
   * the same term as its list — the two are pinned to each other (D174), and a
   * search on one alone would be a chip counting cards the pass cannot see.
   */
  @IsOptional() @IsString() @MaxLength(120) search?: string;
}

/**
 * D174 — the board's list query: the lane, and the station it is pinned to.
 *
 * `status` was a bare `@Query('status')` before this DTO existed and its
 * contract is unchanged: a real ticket status or one of the board's
 * pseudo-filters, and anything unrecognised means "no filter" rather than a
 * 400 (a stale bookmark should show the whole board). That mapping is the
 * controller's `parseFilter`, not a validator here, which is why the field is
 * only typed and bounded and never checked against a list.
 */
export class QueryKitchenTicketsDto extends QueryKitchenLaneCountsDto {
  @IsOptional() @IsString() @MaxLength(32) status?: string;
}

/**
 * D175 — a repeatable id query param, as an array whatever its arity.
 *
 * `?stationId=a&stationId=b` reaches the pipe as `['a', 'b']`, but a lone
 * `?stationId=a` reaches it as the string `'a'`, and class-transformer's
 * implicit conversion does not wrap a scalar into the declared array type —
 * it hands `'a'` through and `@IsArray` refuses it. Wrapping here is what lets
 * the client send the same param one way for one value and for many. Absent
 * stays absent, so `@IsOptional` still sees the field as not given.
 */
function asIdList({ value }: { value: unknown }): unknown {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * D142 — the ticket history screen's query.
 *
 * Page and size come from the shared pager (1 / 25, capped at 200) so this
 * list behaves like every other list in the product. `search` is bounded the
 * way the sales list bounds its own: a term long enough to be a sentence is a
 * mistake, not a query, and refusing it here beats handing Postgres a
 * megabyte to `ILIKE`.
 *
 * D175 — `stationId` and `tableId` are the structured filters that replaced
 * the search's station-name and table/tab/area legs. Each is repeatable and
 * arrives as a set of ids; an empty or absent set is no filter on that axis,
 * and the service, not the pipe, is where that rule lives. Singular names on
 * the wire because that is what a repeated query param reads as —
 * `?tableId=x&tableId=y` — while the service takes them as the plural sets
 * they are. Fifty is a bound on a mistake, not a feature: a branch with more
 * tables than that is not filtering, it is listing.
 */
export class QueryKitchenHistoryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;

  @IsOptional()
  @Transform(asIdList)
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  stationId?: string[];

  @IsOptional()
  @Transform(asIdList)
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  tableId?: string[];
}
