import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// A timeslot is supplied as start + duration (D47). `endAt` is derived on the
// server so the two can never disagree. Durations are clamped to something a
// restaurant would actually book: 15 minutes to 12 hours.
//
// Neither DTO accepts `status` (lifecycle moves through the status endpoint,
// which owns the transition table) or `createdByUserId` (server attribution).

export class CreateReservationDto {
  @IsString() tableId!: string;

  /** Optional link to a Customer row; name/phone below are stored regardless. */
  @IsOptional() @IsString() customerId?: string;
  @IsString() @Length(1, 120) customerName!: string;
  @IsOptional() @IsString() @MaxLength(32) customerPhone?: string;

  @Type(() => Number) @IsInt() @Min(1) @Max(200) partySize!: number;

  @IsISO8601() startAt!: string;
  @Type(() => Number) @IsInt() @Min(15) @Max(720) durationMinutes!: number;

  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class UpdateReservationDto {
  @IsOptional() @IsString() tableId?: string;
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() @Length(1, 120) customerName?: string;
  @IsOptional() @IsString() @MaxLength(32) customerPhone?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) partySize?: number;
  @IsOptional() @IsISO8601() startAt?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(15) @Max(720) durationMinutes?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

/**
 * Targets only the states a person can push a reservation into. BOOKED is
 * reachable exclusively as the "un-seat" correction (SEATED → BOOKED);
 * the transition table in the service is the authority.
 */
export class SetReservationStatusDto {
  @IsIn(['BOOKED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])
  status!: 'BOOKED' | 'SEATED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
}
