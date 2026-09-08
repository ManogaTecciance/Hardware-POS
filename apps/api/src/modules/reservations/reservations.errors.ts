import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

export const RESERVATION_ERROR_CODES = {
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  TABLE_NOT_FOUND: 'TABLE_NOT_FOUND',
  RESERVATION_NOT_FOUND: 'RESERVATION_NOT_FOUND',
  RESERVATION_OVERLAP: 'RESERVATION_OVERLAP',
  RESERVATION_IN_PAST: 'RESERVATION_IN_PAST',
  RESERVATION_INVALID_WINDOW: 'RESERVATION_INVALID_WINDOW',
  RESERVATION_STATUS_CONFLICT: 'RESERVATION_STATUS_CONFLICT',
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
