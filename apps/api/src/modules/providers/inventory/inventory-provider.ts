import { Prisma } from '@hardware-pos/database';

import {
  AvailabilityMap,
  ProviderContext,
  ProviderInventoryMode,
  ProviderSyncOutcome,
  ReceiveStockLine,
  ReceiveStockLineOutcome,
  StockAdjustment,
  StockLine,
} from '../provider.types';

/**
 * Where stock lives and who is authoritative for it.
 *
 * ## Scope
 *
 * Every method here exists because the current code already does it. Nothing is
 * modelled speculatively:
 *
 * | Method | Existing behaviour it abstracts |
 * |---|---|
 * | `getAvailability` | `sales.service.computeCart` reads `product.quantityOnHand` and rejects a line that exceeds it |
 * | `reduceStock` | `sales.repository.decrementStock` — the conditional `updateMany` inside the sale transaction |
 * | `restoreStock` | `returns.repository` — the eager `increment` for GOOD / RETURN_TO_STOCK items |
 * | `adjustStock` | the bulk product import writes on-hand quantities today; Slice 6 routes that through here |
 * | `synchronize` | `POST /v1/sync/products/refresh` and `POST /v1/products/sync/mock` pull products from QuickBooks |
 *
 * Deliberately **absent**: `reserveStock`. There is no reservation anywhere in the
 * repository — no held-stock column, no reservation table, no expiry. Adding it
 * would be a speculative interface for a feature that does not exist.
 *
 * ## Transaction contract — the highest-risk detail of the whole refactor
 *
 * Every mutating method takes the caller's `Prisma.TransactionClient` as its first
 * parameter and **must** perform all its writes through it.
 *
 * An implementation must never call `prisma.$transaction(...)` or reach for the
 * root `PrismaService`. Today's `decrementStock` guards against overselling with a
 * conditional `updateMany({ where: { quantityOnHand: { gte: qty } } })` and a
 * row-count check: a zero-row update throws and the **entire sale** rolls back. A
 * provider that opened its own connection would commit the stock movement
 * independently of the sale, so overselling becomes possible again and the
 * transactional outbox stops being an outbox.
 *
 * The caller owns transaction boundaries. A provider failure must therefore
 * propagate, so it participates in the caller's rollback.
 *
 * ## Tenant safety
 *
 * `ctx.tenantId` always comes from the authenticated server-side context; no
 * implementation may read a tenant id from a request. Every product write is
 * additionally scoped by `tenantId` in its `where` clause, so a product id
 * belonging to another tenant matches zero rows rather than being mutated.
 */
export interface InventoryProvider {
  /** Which `InventoryMode` this implementation serves. Used by tests and logs. */
  readonly mode: ProviderInventoryMode;

  /** Human-readable provider name, safe for error messages and logs. */
  readonly name: string;

  /**
   * On-hand availability for the given products.
   *
   * Read-only, so it takes no transaction client — callers ask before opening one.
   * Products the provider cannot find are omitted from the map rather than
   * reported as zero, so a caller can tell "unknown product" from "out of stock".
   */
  getAvailability(ctx: ProviderContext, productIds: string[]): Promise<AvailabilityMap>;

  /**
   * Reduce stock for a completed sale, inside the caller's transaction.
   *
   * Must be safe under concurrency: two simultaneous sales of the last unit must
   * not both succeed.
   */
  reduceStock(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    lines: StockLine[],
  ): Promise<void>;

  /**
   * Restore stock for an approved return, inside the caller's transaction.
   *
   * The caller decides *which* lines restock (condition and disposition are
   * return-domain rules, not inventory rules) and passes only those.
   */
  restoreStock(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    lines: StockLine[],
  ): Promise<void>;

  /**
   * Apply explicit signed stock corrections, inside the caller's transaction.
   *
   * Unlike `reduceStock` this does **not** guard against going negative: a
   * stocktake correction is an assertion of reality by an operator, and refusing
   * it would leave the books wrong. Authorisation is the caller's job.
   */
  adjustStock(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    adjustments: StockAdjustment[],
  ): Promise<void>;

  /**
   * Apply the stock effect of a vendor `InventoryReceipt`, inside the caller's
   * transaction (D44).
   *
   * The caller has already inserted the immutable `InventoryReceipt` header and
   * every `InventoryReceiptLine`. This method is responsible for the *side
   * effects* of those lines:
   *
   *  1. upserting the branch's `BranchInventory` cell for each line —
   *     `quantityOnHand += quantityReceived`, `averageCost` recomputed from the
   *     pre-receipt balance and the received unitCost (weighted average),
   *  2. appending a `StockMovement` per line with `reason: RECEIPT`,
   *     `refType: 'INVENTORY_RECEIPT_LINE'`, `refId: line.receiptLineId`,
   *     `unitCost: line.unitCost`,
   *  3. for `LOCAL` inventory (single-branch tenants only, per the class
   *     comment), keeping `Product.quantityOnHand` in sync as the legacy
   *     rollup + QuickBooks cache mirror (D10).
   *
   * Returned outcomes are per line, in input order, and carry the post-receipt
   * balance + weighted-average snapshot for that (branch, product, variant?)
   * cell — the caller uses them to refresh the mirror on
   * `ProductVariant.averageCost` (or `Product.averageCost` for a legacy
   * variant-less line) and to compose the receipt response.
   *
   * Providers that cannot receive stock (QuickBooks — stock is owned upstream;
   * NONE — stock tracking is off) **must throw**
   * `ProviderOperationUnavailableError`. A silent no-op would look like a
   * successful receive that never moved stock, so the receipt would live in the
   * database with no ledger effect — precisely the "receipt with no stock
   * change" state D44 forbids.
   */
  receiveStock(
    tx: Prisma.TransactionClient,
    ctx: ProviderContext,
    lines: ReceiveStockLine[],
    metadata: { receiptId: string; createdByUserId: string },
  ): Promise<ReceiveStockLineOutcome[]>;

  /**
   * Ask the provider to reconcile with its upstream system.
   *
   * Not transactional: synchronisation is a long-running background concern, and
   * holding a database transaction open across an external API call is exactly the
   * mistake this signature refuses to make possible.
   */
  synchronize(ctx: ProviderContext): Promise<ProviderSyncOutcome>;
}

/** DI token. An interface has no runtime identity, so injection needs a symbol. */
export const INVENTORY_PROVIDER_FACTORY = Symbol('INVENTORY_PROVIDER_FACTORY');
