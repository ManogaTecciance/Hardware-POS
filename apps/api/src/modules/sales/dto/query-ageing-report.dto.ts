import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * `8.6` — the ageing report takes an age, not a date range.
 *
 * "What has not moved in 90 days" is a question about a single moment, not a
 * period: the answer is about the shelf as it stands, looking backwards.
 */
export class QueryAgeingReportDto {
  /**
   * How still a line has to be to count. Inclusive: 90 means 90.
   *
   * Capped at ten years — not a business rule, just a bound on a number that
   * comes off the wire and is then used in arithmetic.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  thresholdDays?: number;

  /**
   * The moment to measure from. Defaults to now.
   *
   * Exposed so a manager can ask "what was sitting still at the end of last
   * season", and so a test can pin the clock instead of computing dates
   * relative to whenever it happens to run.
   */
  @IsOptional()
  @IsDateString()
  asOf?: string;
}
