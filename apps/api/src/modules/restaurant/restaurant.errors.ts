import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

export const RESTAURANT_ERROR_CODES = {
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  CONFIG_VERSION_CONFLICT: 'CONFIG_VERSION_CONFLICT',
  STATION_NOT_FOUND: 'STATION_NOT_FOUND',
  STATION_CODE_TAKEN: 'STATION_CODE_TAKEN',
  STATION_HAS_ITEMS: 'STATION_HAS_ITEMS',
  INVALID_OPENING_HOURS: 'INVALID_OPENING_HOURS',
} as const;

export class BranchNotFoundError extends NotFoundException {
  constructor() {
    super({ code: RESTAURANT_ERROR_CODES.BRANCH_NOT_FOUND, message: 'Branch not found' });
  }
}

export class ConfigVersionConflictError extends ConflictException {
  constructor() {
    super({
      code: RESTAURANT_ERROR_CODES.CONFIG_VERSION_CONFLICT,
      message: 'The configuration was updated by another administrator; reload and retry',
    });
  }
}

export class StationNotFoundError extends NotFoundException {
  constructor() {
    super({ code: RESTAURANT_ERROR_CODES.STATION_NOT_FOUND, message: 'Kitchen station not found' });
  }
}

export class StationCodeTakenError extends ConflictException {
  constructor(code: string) {
    super({
      code: RESTAURANT_ERROR_CODES.STATION_CODE_TAKEN,
      message: `A kitchen station with code ${code} already exists on this branch`,
    });
  }
}

export class StationHasItemsError extends BadRequestException {
  constructor() {
    super({
      code: RESTAURANT_ERROR_CODES.STATION_HAS_ITEMS,
      message: 'Cannot archive a station while menu items still route to it',
    });
  }
}

/**
 * D90 — a schedule the calendar could not draw. Class-validator checks each
 * field in isolation; these are the rules that need two fields at once (a
 * closing time before its opening time) or the whole list (two rules for the
 * same weekday), and they are refused before anything is written rather than
 * left to surface as an unreadable chart.
 */
export class InvalidOpeningHoursError extends BadRequestException {
  constructor(message: string) {
    super({ code: RESTAURANT_ERROR_CODES.INVALID_OPENING_HOURS, message });
  }
}
