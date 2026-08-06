import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

export const MENU_ERROR_CODES = {
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  MENU_NOT_FOUND: 'MENU_NOT_FOUND',
  MENU_NAME_TAKEN: 'MENU_NAME_TAKEN',
  MENU_VERSION_CONFLICT: 'MENU_VERSION_CONFLICT',
  SECTION_NOT_FOUND: 'SECTION_NOT_FOUND',
  SECTION_NAME_TAKEN: 'SECTION_NAME_TAKEN',
  ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
  ITEM_PRODUCT_CROSS_TENANT: 'ITEM_PRODUCT_CROSS_TENANT',
  MODIFIER_GROUP_NOT_FOUND: 'MODIFIER_GROUP_NOT_FOUND',
  MODIFIER_GROUP_NAME_TAKEN: 'MODIFIER_GROUP_NAME_TAKEN',
  MODIFIER_GROUP_INVALID_RANGE: 'MODIFIER_GROUP_INVALID_RANGE',
  MODIFIER_OPTION_NOT_FOUND: 'MODIFIER_OPTION_NOT_FOUND',
  STATION_NOT_FOUND: 'STATION_NOT_FOUND',
} as const;

const err = (code: string, message: string) => ({ code, message });

export class MenuNotFoundError extends NotFoundException {
  constructor() {
    super(err(MENU_ERROR_CODES.MENU_NOT_FOUND, 'Menu not found'));
  }
}
export class MenuNameTakenError extends ConflictException {
  constructor(name: string) {
    super(err(MENU_ERROR_CODES.MENU_NAME_TAKEN, `A menu named "${name}" already exists on this branch`));
  }
}
export class MenuVersionConflictError extends ConflictException {
  constructor() {
    super(err(MENU_ERROR_CODES.MENU_VERSION_CONFLICT, 'Menu was updated by another user; reload and retry'));
  }
}
export class BranchNotFoundError extends NotFoundException {
  constructor() {
    super(err(MENU_ERROR_CODES.BRANCH_NOT_FOUND, 'Branch not found'));
  }
}
export class SectionNotFoundError extends NotFoundException {
  constructor() {
    super(err(MENU_ERROR_CODES.SECTION_NOT_FOUND, 'Menu section not found'));
  }
}
export class SectionNameTakenError extends ConflictException {
  constructor(name: string) {
    super(err(MENU_ERROR_CODES.SECTION_NAME_TAKEN, `A section named "${name}" already exists in this menu`));
  }
}
export class ItemNotFoundError extends NotFoundException {
  constructor() {
    super(err(MENU_ERROR_CODES.ITEM_NOT_FOUND, 'Menu item not found'));
  }
}
export class ItemProductCrossTenantError extends BadRequestException {
  constructor() {
    super(err(MENU_ERROR_CODES.ITEM_PRODUCT_CROSS_TENANT, 'Referenced product does not belong to this tenant'));
  }
}
export class ModifierGroupNotFoundError extends NotFoundException {
  constructor() {
    super(err(MENU_ERROR_CODES.MODIFIER_GROUP_NOT_FOUND, 'Modifier group not found'));
  }
}
export class ModifierGroupNameTakenError extends ConflictException {
  constructor(name: string) {
    super(
      err(
        MENU_ERROR_CODES.MODIFIER_GROUP_NAME_TAKEN,
        `A modifier group named "${name}" already exists`,
      ),
    );
  }
}
export class ModifierGroupInvalidRangeError extends BadRequestException {
  constructor() {
    super(
      err(
        MENU_ERROR_CODES.MODIFIER_GROUP_INVALID_RANGE,
        'minSelections must be ≤ maxSelections; SINGLE selection requires maxSelections = 1',
      ),
    );
  }
}
export class ModifierOptionNotFoundError extends NotFoundException {
  constructor() {
    super(err(MENU_ERROR_CODES.MODIFIER_OPTION_NOT_FOUND, 'Modifier option not found'));
  }
}
export class StationNotFoundError extends NotFoundException {
  constructor() {
    super(err(MENU_ERROR_CODES.STATION_NOT_FOUND, 'Kitchen station not found for this branch'));
  }
}
