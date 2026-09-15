import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

export const RESERVATION_ERROR_CODES = {
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  TABLE_NOT_FOUND: 'TABLE_NOT_FOUND',
  RESERVATION_NOT_FOUND: 'RESERVATION_NOT_FOUND',
  RESERVATION_OVERLAP: 'RESERVATION_OVERLAP',
  RESERVATION_IN_PAST: 'RESERVATION_IN_PAST',
  RESERVATION_INVALID_WINDOW: 'RESERVATION_INVALID_WINDOW',
  RESERVATION_STATUS_CONFLICT: 'RESERVATION_STATUS_CONFLICT',
  RESERVATION_NO_SHOW_TOO_EARLY: 'RESERVATION_NO_SHOW_TOO_EARLY',
} as const;

const err = (code: string, message: string) => ({ code, message });

export class BranchNotFoundError extends NotFoundException {
  constructor() {
    super(err(RESERVATION_ERROR_CODES.BRANCH_NOT_FOUND, 'Branch not found'));
  }
}
export class TableNotFoundError extends NotFoundException {
  constructor() {
    super(err(RESERVATION_ERROR_CODES.TABLE_NOT_FOUND, 'Table not found'));
  }
}
export class ReservationNotFoundError extends NotFoundException {
  constructor() {
    super(err(RESERVATION_ERROR_CODES.RESERVATION_NOT_FOUND, 'Reservation not found'));
  }
}

/**
 * Names the blocking reservation's number (staff vocabulary, not PII) so the
 * clerk on the losing side of the race can find it on the calendar; the
 * customer's name deliberately stays out of the error.
 */
export class ReservationOverlapError extends ConflictException {
  constructor(reservationNumber: string) {
    super(
      err(
        RESERVATION_ERROR_CODES.RESERVATION_OVERLAP,
        `This table is already reserved for that time (${reservationNumber})`,
      ),
    );
  }
}
export class ReservationInPastError extends BadRequestException {
  constructor() {
    super(err(RESERVATION_ERROR_CODES.RESERVATION_IN_PAST, 'Reservations cannot start in the past'));
  }
}
export class InvalidListWindowError extends BadRequestException {
  constructor() {
    super(
      err(
        RESERVATION_ERROR_CODES.RESERVATION_INVALID_WINDOW,
        '`from` must be a valid instant strictly before `to`',
      ),
    );
  }
}
/**
 * D199 — a guest cannot have failed to turn up for a time that has not
 * arrived. Cancel is the verb for a booking withdrawn ahead of time; this
 * names the earliest instant the other verb becomes honest.
 */
export class ReservationNoShowTooEarlyError extends BadRequestException {
  constructor(availableFrom: Date) {
    super(
      err(
        RESERVATION_ERROR_CODES.RESERVATION_NO_SHOW_TOO_EARLY,
        'A no-show can only be recorded once the booked time has passed ' +
          `(from ${availableFrom.toISOString()}). Cancel the reservation instead.`,
      ),
    );
  }
}
export class ReservationStatusConflictError extends ConflictException {
  constructor(from: string, to: string) {
    super(
      err(
        RESERVATION_ERROR_CODES.RESERVATION_STATUS_CONFLICT,
        `A ${from} reservation cannot become ${to}`,
      ),
    );
  }
}
