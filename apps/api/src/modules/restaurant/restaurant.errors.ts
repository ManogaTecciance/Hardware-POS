import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

export const RESTAURANT_ERROR_CODES = {
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  CONFIG_VERSION_CONFLICT: 'CONFIG_VERSION_CONFLICT',
  STATION_NOT_FOUND: 'STATION_NOT_FOUND',
  STATION_CODE_TAKEN: 'STATION_CODE_TAKEN',
  STATION_HAS_ITEMS: 'STATION_HAS_ITEMS',
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
