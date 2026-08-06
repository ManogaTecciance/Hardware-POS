import { ConflictException, NotFoundException } from '@nestjs/common';

export const DINING_ERROR_CODES = {
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  AREA_NOT_FOUND: 'AREA_NOT_FOUND',
  AREA_NAME_TAKEN: 'AREA_NAME_TAKEN',
  AREA_HAS_TABLES: 'AREA_HAS_TABLES',
  TABLE_NOT_FOUND: 'TABLE_NOT_FOUND',
  TABLE_CODE_TAKEN: 'TABLE_CODE_TAKEN',
  TABLE_STATUS_CONFLICT: 'TABLE_STATUS_CONFLICT',
} as const;

const err = (code: string, message: string) => ({ code, message });

export class BranchNotFoundError extends NotFoundException {
  constructor() {
    super(err(DINING_ERROR_CODES.BRANCH_NOT_FOUND, 'Branch not found'));
  }
}
export class AreaNotFoundError extends NotFoundException {
  constructor() {
    super(err(DINING_ERROR_CODES.AREA_NOT_FOUND, 'Dining area not found'));
  }
}
export class AreaNameTakenError extends ConflictException {
  constructor(name: string) {
    super(err(DINING_ERROR_CODES.AREA_NAME_TAKEN, `A dining area named "${name}" already exists on this branch`));
  }
}
export class TableNotFoundError extends NotFoundException {
  constructor() {
    super(err(DINING_ERROR_CODES.TABLE_NOT_FOUND, 'Table not found'));
  }
}
export class TableCodeTakenError extends ConflictException {
  constructor(code: string) {
    super(err(DINING_ERROR_CODES.TABLE_CODE_TAKEN, `Code "${code}" is already used in this dining area`));
  }
}
