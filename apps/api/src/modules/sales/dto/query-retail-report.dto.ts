import { IsDateString } from 'class-validator';

/**
 * The date range every Phase 8 retail report takes.
 *
 * `YYYY-MM-DD` or a full ISO timestamp. A bare date is read as the whole day in
 * the server's zone: `from` at 00:00:00.000 and `to` at 23:59:59.999, so
 * `from=to=today` is "today" rather than an empty instant.
 */
export class QueryRetailReportDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;
}

/** Widen a bare `YYYY-MM-DD` to the day it names. */
export function toReportRange(dto: QueryRetailReportDto): { from: Date; to: Date } {
  const bareDate = /^\d{4}-\d{2}-\d{2}$/;
  return {
    from: new Date(bareDate.test(dto.from) ? `${dto.from}T00:00:00.000` : dto.from),
    to: new Date(bareDate.test(dto.to) ? `${dto.to}T23:59:59.999` : dto.to),
  };
}
