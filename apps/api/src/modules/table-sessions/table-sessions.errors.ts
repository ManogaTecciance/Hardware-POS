import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

export const SESSION_ERROR_CODES = {
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  TABLE_NOT_FOUND: 'TABLE_NOT_FOUND',
  TABLE_ALREADY_OPEN: 'TABLE_ALREADY_OPEN',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_NOT_OPEN: 'SESSION_NOT_OPEN',
  SESSION_ALREADY_CLOSED: 'SESSION_ALREADY_CLOSED',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  MENU_ITEM_NOT_FOUND: 'MENU_ITEM_NOT_FOUND',
  MENU_ITEM_INACTIVE: 'MENU_ITEM_INACTIVE',
  ROUND_ALREADY_SUBMITTED: 'ROUND_ALREADY_SUBMITTED',
  ITEM_ALREADY_SENT: 'ITEM_ALREADY_SENT',
} as const;

const err = (code: string, message: string) => ({ code, message });

export class BranchNotFoundError extends NotFoundException {
  constructor() {
    super(err(SESSION_ERROR_CODES.BRANCH_NOT_FOUND, 'Branch not found'));
  }
}
export class TableNotFoundError extends NotFoundException {
  constructor() {
    super(err(SESSION_ERROR_CODES.TABLE_NOT_FOUND, 'Table not found on this branch'));
  }
}
export class TableAlreadyOpenError extends ConflictException {
  constructor() {
    super(
      err(
        SESSION_ERROR_CODES.TABLE_ALREADY_OPEN,
        'Table already has an open session — close or transfer it first',
      ),
    );
  }
}
export class SessionNotFoundError extends NotFoundException {
  constructor() {
    super(err(SESSION_ERROR_CODES.SESSION_NOT_FOUND, 'Table session not found'));
  }
}
export class SessionNotOpenError extends BadRequestException {
  constructor() {
    super(err(SESSION_ERROR_CODES.SESSION_NOT_OPEN, 'Session is not open'));
  }
}
export class SessionAlreadyClosedError extends ConflictException {
  constructor() {
    super(
      err(
        SESSION_ERROR_CODES.SESSION_ALREADY_CLOSED,
        'Session has already been closed — it produced a Sale',
      ),
    );
  }
}
export class OrderNotFoundError extends NotFoundException {
  constructor() {
    super(err(SESSION_ERROR_CODES.ORDER_NOT_FOUND, 'Order not found'));
  }
}
export class MenuItemNotFoundError extends NotFoundException {
  constructor() {
    super(err(SESSION_ERROR_CODES.MENU_ITEM_NOT_FOUND, 'Menu item not found for this tenant'));
  }
}
export class MenuItemInactiveError extends BadRequestException {
  constructor(name: string) {
    super(err(SESSION_ERROR_CODES.MENU_ITEM_INACTIVE, `Menu item "${name}" is not currently available`));
  }
}
export class RoundAlreadySubmittedError extends ConflictException {
  constructor() {
    super(err(SESSION_ERROR_CODES.ROUND_ALREADY_SUBMITTED, 'Round has already been submitted'));
  }
}
export class ItemAlreadySentError extends ConflictException {
  constructor() {
    super(
      err(
        SESSION_ERROR_CODES.ITEM_ALREADY_SENT,
        'Item has been sent to the kitchen and cannot be silently removed — void instead',
      ),
    );
  }
}
