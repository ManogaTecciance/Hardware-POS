import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

export const SESSION_ERROR_CODES = {
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  TABLE_NOT_FOUND: 'TABLE_NOT_FOUND',
  TABLE_ALREADY_OPEN: 'TABLE_ALREADY_OPEN',
  // D104 — an arrangement carries several tabs, but only as many guests as it
  // has chairs, and only if each tab can be told from its siblings.
  OPEN_TABLE_SEATS_EXHAUSTED: 'OPEN_TABLE_SEATS_EXHAUSTED',
  TAB_NAME_REQUIRED: 'TAB_NAME_REQUIRED',
  GUEST_COUNT_REQUIRED: 'GUEST_COUNT_REQUIRED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_NOT_OPEN: 'SESSION_NOT_OPEN',
  SESSION_ALREADY_CLOSED: 'SESSION_ALREADY_CLOSED',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  MENU_ITEM_NOT_FOUND: 'MENU_ITEM_NOT_FOUND',
  MENU_ITEM_INACTIVE: 'MENU_ITEM_INACTIVE',
  ROUND_ALREADY_SUBMITTED: 'ROUND_ALREADY_SUBMITTED',
  ITEM_ALREADY_SENT: 'ITEM_ALREADY_SENT',
  // D46 — Product / ProductVariant resolution failures on the widened
  // `submitRound` path. Distinct codes from the MenuItem variants so a
  // client can differentiate a bad Product id from a bad MenuItem id.
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  PRODUCT_INACTIVE: 'PRODUCT_INACTIVE',
  // D101 — the item is 86'd. Distinct from INACTIVE so the till can say
  // "sold out" (a shift fact) rather than "not available" (a config fact).
  PRODUCT_SOLD_OUT: 'PRODUCT_SOLD_OUT',
  PRODUCT_VARIANT_NOT_FOUND: 'PRODUCT_VARIANT_NOT_FOUND',
  PRODUCT_VARIANT_INACTIVE: 'PRODUCT_VARIANT_INACTIVE',
  VARIANT_NOT_ON_PRODUCT: 'VARIANT_NOT_ON_PRODUCT',
  VARIANT_SELECTION_REQUIRED: 'VARIANT_SELECTION_REQUIRED',
  MODIFIER_OPTION_NOT_ON_ITEM: 'MODIFIER_OPTION_NOT_ON_ITEM',
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
/**
 * D49: the table is physically absorbed into an open table — seat the open
 * table instead. The message names the recovery, not just the refusal.
 */
export class TableReservedForOpenTableError extends ConflictException {
  constructor() {
    super({
      code: 'TABLE_RESERVED',
      message: 'This table is joined into an open table — seat the open table instead.',
    });
  }
}

/** D52 — the branch has no active register to book the sale against. */
export class RegisterNotFoundError extends NotFoundException {
  constructor() {
    super({
      code: 'REGISTER_NOT_FOUND',
      message: 'No active register on this branch to record the sale against.',
    });
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
/**
 * D104 — the arrangement has chairs, and they are counted.
 *
 * The free count is IN the message because "it does not fit" leaves the waiter
 * guessing at a number the server already knows: a party of three refused on a
 * six-top reads as a bug until you are told four are already sitting there.
 */
export class OpenTableSeatsExhaustedError extends ConflictException {
  constructor(seatsFree: number) {
    super(
      err(
        SESSION_ERROR_CODES.OPEN_TABLE_SEATS_EXHAUSTED,
        seatsFree > 0
          ? `Only ${seatsFree} seat${seatsFree === 1 ? '' : 's'} free on this open table.`
          : 'This open table is full — every seat is taken.',
      ),
    );
  }
}

/**
 * D104 — the second tab must be nameable, or the kitchen cannot tell the two
 * parties apart. Deliberately NOT required for the first tab: naming a tab that
 * has no sibling is typing for nothing, and the arrangement's own name is
 * already unambiguous while it stands alone.
 */
export class TabNameRequiredError extends ConflictException {
  constructor() {
    super(
      err(
        SESSION_ERROR_CODES.TAB_NAME_REQUIRED,
        'Another party is already on this open table — name this tab so the kitchen can tell them apart.',
      ),
    );
  }
}

/**
 * D104 — seats cannot be counted without knowing the party size.
 *
 * Only thrown for an arrangement that HAS a recorded capacity: where the
 * operator wrote "seating as arranged" and left it blank (D49), there is
 * nothing to count against and the guest count stays optional.
 */
export class GuestCountRequiredError extends ConflictException {
  constructor() {
    super(
      err(
        SESSION_ERROR_CODES.GUEST_COUNT_REQUIRED,
        'This open table has a seat count — say how many guests are being seated.',
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
/**
 * D159 — the chosen person cannot be put on a table.
 *
 * 400, not 404: the user may well exist and be perfectly real — what they lack
 * is a role that can send a round to the kitchen, and saying so is more use to
 * the caller than pretending they are not there. The message names the reason
 * because the alternative is a supervisor retrying the same pick.
 */
export class WaiterNotAssignableError extends BadRequestException {
  constructor() {
    super('That user cannot be assigned a table — their role cannot send orders to the kitchen.');
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

// ─────────────────────────────────────────────────────────────
// D46 — Product / ProductVariant resolution failures
// ─────────────────────────────────────────────────────────────
//
// A 404 for "not found for this tenant" is deliberate: the response must
// not distinguish "no such product" from "product exists but on a
// different tenant" — that would leak cross-tenant existence.

export class ProductNotFoundError extends NotFoundException {
  constructor() {
    super(err(SESSION_ERROR_CODES.PRODUCT_NOT_FOUND, 'Product not found for this tenant'));
  }
}

export class ProductInactiveError extends BadRequestException {
  constructor(name: string) {
    super(err(SESSION_ERROR_CODES.PRODUCT_INACTIVE, `Product "${name}" is not currently available`));
  }
}

/** D101 — the item is 86'd; the message names the recovery (the switch). */
export class ProductSoldOutError extends BadRequestException {
  constructor(name: string) {
    super(
      err(
        SESSION_ERROR_CODES.PRODUCT_SOLD_OUT,
        `"${name}" is sold out — mark it available again to sell it`,
      ),
    );
  }
}

export class ProductVariantNotFoundError extends NotFoundException {
  constructor() {
    super(
      err(
        SESSION_ERROR_CODES.PRODUCT_VARIANT_NOT_FOUND,
        'Product variant not found for this tenant',
      ),
    );
  }
}

export class ProductVariantInactiveError extends BadRequestException {
  constructor(sku: string) {
    super(
      err(
        SESSION_ERROR_CODES.PRODUCT_VARIANT_INACTIVE,
        `Product variant "${sku}" is not currently available`,
      ),
    );
  }
}

export class VariantNotOnProductError extends BadRequestException {
  constructor() {
    super(
      err(
        SESSION_ERROR_CODES.VARIANT_NOT_ON_PRODUCT,
        'Selected variant does not belong to the given product',
      ),
    );
  }
}

/**
 * Thrown when a PRODUCT-sourced round item is submitted without a
 * `productVariantId` but the Product carries one or more active variants.
 * The dialog copy from D46 ("Select a size to continue") drives the
 * message so the client can surface it verbatim.
 */
export class VariantSelectionRequiredError extends BadRequestException {
  constructor(productName: string) {
    super(
      err(
        SESSION_ERROR_CODES.VARIANT_SELECTION_REQUIRED,
        `Select a size to continue for "${productName}"`,
      ),
    );
  }
}

/**
 * The referenced modifier option exists (and is tenant-scoped correctly)
 * but its parent group is not attached to the item being ordered — so
 * accepting the option would silently pull an unrelated price delta into
 * the snapshot. Enforced at the service layer because a ModifierGroup is
 * intentionally reusable across items; the DB cannot express "this
 * option is valid for THIS item only".
 */
export class ModifierOptionNotOnItemError extends BadRequestException {
  constructor() {
    super(
      err(
        SESSION_ERROR_CODES.MODIFIER_OPTION_NOT_ON_ITEM,
        'Modifier option is not attached to the ordered item',
      ),
    );
  }
}
