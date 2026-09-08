/**
 * Typed provider errors.
 *
 * These extend `HttpException` so they flow through the existing
 * `AllExceptionsFilter` unchanged, and they put a `code` in the response object —
 * the filter already passes structured extras through (it does the same for the
 * discount-approval hint), so the code reaches the client without touching the
 * filter.
 *
 * Rules every error here follows:
 *
 *  • **Fail closed.** Each one is raised *instead of* doing the work. There is no
 *    error here that a caller is expected to swallow and continue past.
 *  • **No secrets.** Messages carry ids, modes, and branch counts — never tokens,
 *    realm ids, encrypted values, connection strings, or credentials. The
 *    `ProviderErrorCode` is the machine-readable part; the message is for a human
 *    and is safe to display.
 *  • **No silent fallback.** An unsupported provider raises; it never degrades to
 *    QuickBooks, Local, or None.
 */

import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { AccountingProviderKind, InventoryMode } from '@hardware-pos/database';

/** Stable, machine-readable error codes. Safe to expose and to switch on. */
export enum ProviderErrorCode {
  UNSUPPORTED_INVENTORY_PROVIDER = 'PROVIDER_INVENTORY_UNSUPPORTED',
  UNSUPPORTED_ACCOUNTING_PROVIDER = 'PROVIDER_ACCOUNTING_UNSUPPORTED',
  UNSAFE_MULTI_BRANCH_INVENTORY = 'PROVIDER_INVENTORY_MULTI_BRANCH_UNSAFE',
  PRODUCT_NOT_FOUND_IN_TENANT = 'PROVIDER_PRODUCT_NOT_FOUND',
  INVALID_BRANCH_CONTEXT = 'PROVIDER_INVALID_BRANCH_CONTEXT',
  PROVIDER_CONFIGURATION_MISSING = 'PROVIDER_CONFIGURATION_MISSING',
  PROVIDER_OPERATION_UNAVAILABLE = 'PROVIDER_OPERATION_UNAVAILABLE',
  AMBIGUOUS_ACCOUNTING_PROVENANCE = 'PROVIDER_ACCOUNTING_PROVENANCE_AMBIGUOUS',
}

/**
 * Base class for every provider failure.
 *
 * `instanceof ProviderError` lets a caller (and a test) distinguish a provider
 * refusing to act from an unrelated `BadRequestException`.
 */
export class ProviderError extends HttpException {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string, status: HttpStatus) {
    super({ statusCode: status, message, error: 'ProviderError', code }, status);
    this.code = code;
  }
}

/**
 * An inventory mode with no implementation — `EXTERNAL` today.
 *
 * 501 rather than 400: the request is well-formed and the tenant's configuration
 * is legitimate; AxloPOS simply has not built this provider yet.
 */
export class UnsupportedInventoryProviderError extends ProviderError {
  constructor(mode: InventoryMode | string) {
    super(
      ProviderErrorCode.UNSUPPORTED_INVENTORY_PROVIDER,
      `Inventory mode '${mode}' is not supported yet. ` +
        'Configure LOCAL, QUICKBOOKS, or DISABLED inventory for this tenant.',
      HttpStatus.NOT_IMPLEMENTED,
    );
  }
}

/** An accounting provider with no implementation — `FUTURE_EXTERNAL` today. */
export class UnsupportedAccountingProviderError extends ProviderError {
  constructor(provider: AccountingProviderKind | string) {
    super(
      ProviderErrorCode.UNSUPPORTED_ACCOUNTING_PROVIDER,
      `Accounting provider '${provider}' is not supported yet. ` +
        'Configure QUICKBOOKS or NONE accounting for this tenant.',
      HttpStatus.NOT_IMPLEMENTED,
    );
  }
}

/**
 * Local inventory asked to act for a tenant with more than one branch.
 *
 * `Product.quantityOnHand` is a single global number per product with no branch
 * dimension (decision D10). Using it for a multi-branch tenant would silently
 * report and move the wrong branch's stock, so this refuses instead. 409 because
 * it is a conflict between the tenant's configuration and the data model, and it
 * is resolved by configuration or by Phase 2.5's branch-scoped inventory — not by
 * retrying or by changing the request.
 */
export class UnsafeMultiBranchInventoryError extends ProviderError {
  constructor(tenantId: string, branchCount: number) {
    super(
      ProviderErrorCode.UNSAFE_MULTI_BRANCH_INVENTORY,
      `Tenant ${tenantId} has ${branchCount} active branches, and LOCAL inventory ` +
        'cannot be branch-correct until branch-scoped inventory exists. ' +
        'Use QUICKBOOKS or DISABLED inventory, or operate a single branch.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * A product id that does not belong to this tenant (or does not exist).
 *
 * Both cases give the same message on purpose: telling a caller that an id exists
 * but belongs to someone else is a cross-tenant existence oracle.
 */
export class ProductNotFoundInTenantError extends ProviderError {
  constructor(productId: string) {
    super(
      ProviderErrorCode.PRODUCT_NOT_FOUND_IN_TENANT,
      `Product ${productId} was not found`,
      HttpStatus.NOT_FOUND,
    );
  }
}

/** A branch id that is missing when required, or not this tenant's. */
export class InvalidBranchContextError extends ProviderError {
  constructor(detail: string) {
    super(
      ProviderErrorCode.INVALID_BRANCH_CONTEXT,
      `Invalid branch context: ${detail}`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * A provider that needs configuration it does not have — QuickBooks inventory or
 * accounting for a tenant with no active `QuickBooksConnection`.
 *
 * Names no credential and no token, only the fact that a connection is absent.
 */
export class ProviderConfigurationMissingError extends ProviderError {
  constructor(providerName: string, detail: string) {
    super(
      ProviderErrorCode.PROVIDER_CONFIGURATION_MISSING,
      `${providerName} is not configured for this tenant: ${detail}`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * A port operation this provider genuinely cannot perform.
 *
 * Distinct from a no-op: `NoInventoryProvider.reduceStock` is a deliberate,
 * successful no-op, whereas this is a refusal. Never used to paper over a missing
 * implementation that should have been written.
 */
export class ProviderOperationUnavailableError extends ProviderError {
  constructor(providerName: string, operation: string) {
    super(
      ProviderErrorCode.PROVIDER_OPERATION_UNAVAILABLE,
      `${providerName} does not support '${operation}'`,
      HttpStatus.NOT_IMPLEMENTED,
    );
  }
}

/**
 * A persisted sale or return whose stored accounting evidence cannot be read as
 * one provider.
 *
 * Raised instead of falling back to the tenant's *current* profile, which is the
 * specific mistake this error exists to prevent: a return must reverse the entry
 * where the original sale was actually filed, not wherever the tenant happens to
 * be configured now.
 *
 * 409 rather than 400 or 500: the request is well-formed and the server is
 * healthy — the stored row is in a state no valid workflow produces, and it is
 * fixed by correcting the data, not by retrying.
 *
 * Names only the entity, its id, and the contradiction. No token, no realm id, no
 * connection state.
 */
export class AmbiguousAccountingProvenanceError extends ProviderError {
  constructor(entity: 'sale' | 'return', entityId: string, detail: string) {
    super(
      ProviderErrorCode.AMBIGUOUS_ACCOUNTING_PROVENANCE,
      `Cannot determine which accounting system ${entity} ${entityId} belongs to: ${detail}. ` +
        'Refusing to guess, because the wrong choice would either duplicate or omit a ' +
        'financial entry.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Insufficient stock.
 *
 * Deliberately a plain `BadRequestException` with the **exact** message the
 * current `sales.repository.decrementStock` throws — `Insufficient stock for
 * ${name}` — because the POS surfaces it verbatim and the Slice 3
 * characterisation specs assert it. Making this a `ProviderError` would change a
 * user-visible string and an asserted one, so it stays as it is.
 */
export function insufficientStockError(productName: string): BadRequestException {
  return new BadRequestException(`Insufficient stock for ${productName}`);
}

/** Re-exported so callers can narrow without importing from @nestjs/common. */
export { NotFoundException };
