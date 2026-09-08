import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

export const MENU_ERROR_CODES = {
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  MENU_NOT_FOUND: 'MENU_NOT_FOUND',
  MENU_NAME_TAKEN: 'MENU_NAME_TAKEN',
  MENU_VERSION_CONFLICT: 'MENU_VERSION_CONFLICT',
  MENU_HAS_SECTIONS: 'MENU_HAS_SECTIONS',
  SECTION_NOT_FOUND: 'SECTION_NOT_FOUND',
  SECTION_NAME_TAKEN: 'SECTION_NAME_TAKEN',
  SECTION_HAS_ITEMS: 'SECTION_HAS_ITEMS',
  ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
  ITEM_PRODUCT_CROSS_TENANT: 'ITEM_PRODUCT_CROSS_TENANT',
  ITEM_ON_OPEN_ORDER: 'ITEM_ON_OPEN_ORDER',
  MISSING_IMAGE_UPLOAD: 'MISSING_IMAGE_UPLOAD',
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

/// Permanent-delete guards. The frontend surfaces the count so the operator
/// knows what stands in the way of removing the parent.
export class MenuHasSectionsError extends ConflictException {
  constructor(sectionCount: number) {
    super({
      code: MENU_ERROR_CODES.MENU_HAS_SECTIONS,
      message:
        `This menu still contains ${sectionCount} section${sectionCount === 1 ? '' : 's'}. ` +
        'Remove or move them before permanently deleting the menu.',
      details: { sectionCount },
    });
  }
}
export class SectionHasItemsError extends ConflictException {
  constructor(itemCount: number) {
    super({
      code: MENU_ERROR_CODES.SECTION_HAS_ITEMS,
      message:
        `This section contains ${itemCount} menu item${itemCount === 1 ? '' : 's'}. ` +
        'Move or permanently delete those items before deleting this section.',
      details: { itemCount },
    });
  }
}
export class MissingImageUploadError extends BadRequestException {
  constructor() {
    super({
      code: MENU_ERROR_CODES.MISSING_IMAGE_UPLOAD,
      message: 'Upload a JPG, PNG or WEBP image.',
    });
  }
}
export class ItemOnOpenOrderError extends ConflictException {
  constructor(openOrderCount: number) {
    super({
      code: MENU_ERROR_CODES.ITEM_ON_OPEN_ORDER,
      message:
        `This item is on ${openOrderCount} open order${openOrderCount === 1 ? '' : 's'}. ` +
        'Wait for those orders to close before permanently deleting it, or set it Inactive so no ' +
        'new orders can include it.',
      details: { openOrderCount },
    });
  }
}
