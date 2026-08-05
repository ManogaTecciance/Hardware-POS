/**
 * AxloPOS-owned input and result types for the provider ports.
 *
 * Deliberately free of two things:
 *
 *  • **QuickBooks SDK types.** A port that mentions an Intuit type is not an
 *    abstraction — it makes every other implementation speak QuickBooks. Nothing
 *    here imports from `intuit-oauth`, `node-quickbooks`, or the QuickBooks
 *    module's own client types.
 *  • **REST DTOs.** `CreateSaleDto` and friends are HTTP transport shapes with
 *    class-validator decorators. Passing one into a provider would couple a
 *    domain port to the wire format and drag validation metadata into the
 *    inventory layer.
 *
 * Quantities are plain `number`, matching the existing convention rather than
 * inventing a new one: the Prisma columns are `Decimal(12,3)`, and the current
 * code reads them with `Number(product.quantityOnHand)`, computes in `number`
 * (see `ComputedLine.quantity`), and lets Prisma widen back to Decimal on write.
 * Using `Prisma.Decimal` in the port would diverge from every existing call site
 * Slice 6 has to adopt.
 */

import { InventoryMode, PaymentStatus } from '@hardware-pos/database';

/**
 * Who the operation is for.
 *
 * `tenantId` is mandatory and always originates from the authenticated
 * server-side context — the caller resolves it from the verified session before
 * constructing this. No provider accepts a tenant id from an unauthenticated
 * client, and no provider method reads one from a request.
 *
 * `branchId` is explicit rather than optional-by-omission so a caller cannot
 * forget it: `null` is a deliberate statement that the operation is tenant-wide,
 * which is exactly the case `LocalInventoryProvider` must be able to reject for a
 * multi-branch tenant.
 */
export interface ProviderContext {
  tenantId: string;
  branchId: string | null;
}

/**
 * One product line whose stock is moving.
 *
 * Mirrors the fields `sales.repository.decrementStock` already uses:
 * `productId`, `productName` (for the user-facing insufficient-stock message),
 * `quantity`, and `trackInventory` (only `Inventory`-type products move stock).
 */
export interface StockLine {
  productId: string;
  /** Used verbatim in user-facing errors, exactly as the current code does. */
  productName: string;
  quantity: number;
  trackInventory: boolean;
}

/**
 * An explicit stock correction — a signed delta, not an absolute quantity.
 *
 * Distinct from {@link StockLine} on purpose: a sale reduces and a return
 * restores, both unsigned in the caller's language, whereas an adjustment is a
 * stocktake correction that can go either way.
 */
export interface StockAdjustment {
  productId: string;
  productName: string;
  /** Signed: positive adds, negative removes. */
  delta: number;
  trackInventory: boolean;
}

/** What a provider knows about one product's availability. */
export interface ProductAvailability {
  productId: string;
  /** `false` for Service-type products, which never constrain a sale. */
  trackInventory: boolean;
  /**
   * On-hand quantity, or `null` when the provider does not track a number for
   * this product (a non-inventory item, or a provider that tracks nothing).
   */
  quantityOnHand: number | null;
  /**
   * `true` when the provider imposes no ceiling, so a caller must not compare
   * against `quantityOnHand`. This is how `NoInventoryProvider` says "unlimited"
   * without pretending to a quantity it does not have.
   */
  isUnlimited: boolean;
}

/** Availability keyed by product id. Products the provider did not find are absent. */
export type AvailabilityMap = ReadonlyMap<string, ProductAvailability>;

/**
 * Result of asking a provider to synchronise.
 *
 * `requested: false` is the honest answer from a provider with nothing to
 * synchronise — it must not report a successful sync that never happened.
 */
export interface ProviderSyncOutcome {
  /** Whether the provider actually initiated or queued any work. */
  requested: boolean;
  /** How many units of work were queued. Zero when `requested` is false. */
  queued: number;
  /** Safe, human-readable summary. Never contains credentials or tokens. */
  detail: string;
}

/**
 * The financial facts of a completed sale needed to choose an accounting
 * document — nothing more.
 *
 * Deliberately not `Sale`, `SaleWithRelations`, or a DTO: the decision depends on
 * exactly these three values today, and a narrow input keeps the port honest
 * about what it reads.
 */
export interface SaleFinancialShape {
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID';
  /** Whether a customer is attached. QuickBooks Invoices require a CustomerRef. */
  hasCustomer: boolean;
  total: number;
}

/** The facts needed to choose a return document. */
export interface ReturnFinancialShape {
  /**
   * Payment status of the ORIGINAL sale being returned against.
   *
   * The full `PaymentStatus`, including `REFUNDED`, because this is read off a
   * persisted sale rather than computed in-flight like {@link SaleFinancialShape}.
   * Widened in Slice 6B so the adoption needed no cast — `resolveQboDocType`
   * already took the whole enum and compared it against `PAID`, so every status
   * other than `PAID` behaves exactly as it did.
   */
  originalPaymentStatus: PaymentStatus;
  /** How the refund is being given back. */
  refundMethod: string;
}

/**
 * A provider's document-type decision.
 *
 * `documentType: null` means "this tenant has no external accounting, so there is
 * no document" — a first-class answer, not a failure. Both `Sale` and `Return`
 * already have a nullable `quickbooksDocumentType` column, so null persists
 * without a migration.
 *
 * `requiresCustomer` is returned rather than thrown so the *caller* keeps raising
 * its existing user-facing error with its existing message. That keeps Slice 6 a
 * pure extraction instead of a change in error behaviour.
 */
export interface DocumentTypeDecision<T extends string> {
  documentType: T | null;
  requiresCustomer: boolean;
}

/**
 * What actually happened when a document was handed to the accounting layer.
 *
 * A discriminated union rather than `void`, and rather than the ambiguous pair
 * `{ markSynced: true, externalDocumentType: null }`. That combination cannot be
 * read correctly by anyone: it says a synchronisation succeeded while also saying
 * there is no document, so a caller genuinely cannot tell "posted to QuickBooks"
 * from "no accounting system is configured" — and the safe-looking reading is the
 * wrong one.
 *
 * The two states are therefore named:
 *
 *  • `QUEUED` — the document was written to the transactional outbox and the sync
 *    worker will push it. Carries the external document type.
 *  • `NOT_REQUIRED` — the tenant has no external accounting. The transaction
 *    completed **locally and completely**; nothing was synchronised, nothing was
 *    queued, and no external document exists. This is a success, not a degraded
 *    outcome, and it must never be reported as a synchronisation.
 *
 * Deliberately an application-level union: no new Prisma enum, no migration. The
 * persisted columns are unchanged — `Sale.quickbooksDocumentType` stays nullable
 * and a `NOT_REQUIRED` sale simply stores `null`, exactly as it would today.
 *
 * Carries no secret and no provider-specific detail: a provider discriminator, a
 * document type, and nothing else. No realm id, no token, no connection state.
 */
export type AccountingSubmissionResult<T extends string = string> =
  | {
      disposition: 'QUEUED';
      provider: 'QUICKBOOKS';
      externalDocumentType: T;
    }
  | {
      disposition: 'NOT_REQUIRED';
      provider: 'NONE';
      externalDocumentType: null;
    };

/** Convenience alias: `InventoryMode` values a provider may report. */
export type ProviderInventoryMode = InventoryMode;
