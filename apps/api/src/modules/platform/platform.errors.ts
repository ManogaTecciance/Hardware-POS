import { HttpException, HttpStatus } from '@nestjs/common';
import { InventoryMode } from '@hardware-pos/database';

/**
 * Platform-configuration errors.
 *
 * Deliberately *not* in `providers/provider.errors.ts`, even though this one is
 * about inventory. `BusinessProfileService` importing from `providers/` would
 * weaken the adoption tripwire in `provider-contract.spec.ts`, which asserts that
 * only the modules that genuinely resolve a provider reach into that directory.
 * This is a validation error on a profile write, not a provider refusing to act,
 * so it belongs with the module that owns the profile.
 *
 * Same response shape as `ProviderError` — `{ statusCode, message, error, code }` —
 * so `AllExceptionsFilter` passes the machine-readable code straight through.
 */
export enum PlatformErrorCode {
  UNSAFE_INVENTORY_MODE_TRANSITION = 'PLATFORM_INVENTORY_MODE_TRANSITION_UNSAFE',
}

export class PlatformError extends HttpException {
  readonly code: PlatformErrorCode;

  constructor(code: PlatformErrorCode, message: string, status: HttpStatus) {
    super({ statusCode: status, message, error: 'PlatformError', code }, status);
    this.code = code;
  }
}

/**
 * Refuse to move a tenant's inventory authority after stock has already moved.
 *
 * Inventory is resolved from the tenant's **current** mode, because there is no
 * per-sale inventory provenance the way there is for accounting — and inventing
 * one from QuickBooks accounting metadata would conflate two separate concepts.
 * That makes "current" safe only while the mode cannot change underneath existing
 * transactions.
 *
 * It cannot be made safe by choosing a default. `QUICKBOOKS → LOCAL` would make
 * AxloPOS authoritative for quantities QuickBooks still owns, and the next product
 * pull would overwrite them. `LOCAL → QUICKBOOKS` hands authority to a system that
 * never saw the movements. Either direction into `DISABLED` abandons a running
 * count. A return against a sale made before the switch has no defensible place to
 * restock, so this refuses rather than guessing.
 *
 * 409, not 400: the request is well-formed and the configuration is legitimate in
 * the abstract — it conflicts with data that already exists. It is resolved by
 * migrating stock or by starting a new tenant, not by retrying.
 *
 * Names counts, never customer or product data.
 */
export class UnsafeInventoryModeTransitionError extends PlatformError {
  constructor(
    from: InventoryMode,
    to: InventoryMode,
    counts: { sales: number; returns: number },
  ) {
    super(
      PlatformErrorCode.UNSAFE_INVENTORY_MODE_TRANSITION,
      `Cannot change inventory mode from ${from} to ${to}: this tenant already has ` +
        `${counts.sales} completed sale(s) and ${counts.returns} return(s) whose stock was ` +
        `moved under ${from}. Changing inventory authority now would leave those quantities ` +
        'owned by no system, and a return against them would have nowhere safe to restock. ' +
        'Migrating existing stock between inventory authorities is not supported yet.',
      HttpStatus.CONFLICT,
    );
  }
}
