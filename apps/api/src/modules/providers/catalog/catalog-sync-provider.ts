import { InventoryMode } from '@hardware-pos/database';

import {
  CatalogRefreshOutcome,
  CatalogSyncResult,
  ProductCatalogShape,
  ProviderContext,
} from '../provider.types';

/**
 * Whether, and where, a product change is mirrored into an external catalogue.
 *
 * ## Why this is not part of `InventoryProvider`
 *
 * A catalogue and a stock ledger are different things, and folding them together
 * would break the port that already works:
 *
 *  • **`DISABLED` inventory still has a catalogue.** A restaurant that tracks no
 *    stock still has a product list. On a combined port every stock method would be
 *    a no-op while every catalogue method had to really work — a provider that is
 *    half no-op and half not.
 *  • **`NoInventoryProvider` would stop being a no-op.** Its whole guarantee is
 *    structural: it holds no `PrismaService` and no `SyncQueueService`, so it
 *    *cannot* write a row, and a contract test asserts that. Giving it a working
 *    `productCreated` would destroy that guarantee.
 *  • **The two answer different questions.** "How much is on hand at this branch"
 *    and "does this item exist in the accounting system" have different
 *    authorities, and Slice 6C-A's D29 guard shows how much depends on keeping the
 *    inventory authority narrow.
 *
 * So this is a separate port resolved by a separate factory — which still routes on
 * `InventoryMode` (D28), because the catalogue lives wherever inventory is mastered.
 *
 * ## What it owns, and what it does not
 *
 * It owns **only the external synchronisation consequence** of a local change.
 * Local product persistence stays in `ProductsService` and `ProductsRepository`:
 * this port never creates, updates, or deletes a `Product` row. It reports what it
 * did, and the caller applies the local consequence — which is why every method
 * returns a {@link CatalogSyncResult} rather than a `Product`.
 *
 * That split is the reason `ProductsService` needs no profile conditionals. It
 * resolves one provider per operation and reacts to a provider-neutral disposition;
 * it never asks "is this tenant on QuickBooks".
 */
export interface CatalogSyncProvider {
  /** The `InventoryMode` this implementation serves. */
  readonly mode: InventoryMode;

  /** Human-readable name, safe for error messages and logs. */
  readonly name: string;

  /**
   * A product was created locally.
   *
   * Abstracts `products.service.create`'s unconditional `queueQuickBooksPush`.
   */
  productCreated(ctx: ProviderContext, product: ProductCatalogShape): Promise<CatalogSyncResult>;

  /**
   * A product was updated locally.
   *
   * Takes both rows because the QuickBooks implementation must decide whether a
   * *mirrored* field changed — `qboFieldsChanged`, moved here unchanged. That
   * decision is QuickBooks' own, not the product domain's: another catalogue would
   * mirror a different set of fields.
   */
  productUpdated(
    ctx: ProviderContext,
    before: ProductCatalogShape,
    after: ProductCatalogShape,
  ): Promise<CatalogSyncResult>;

  /** A product was deactivated locally. */
  productDeactivated(
    ctx: ProviderContext,
    product: ProductCatalogShape,
  ): Promise<CatalogSyncResult>;

  /**
   * Explicitly push one product, from the operator-triggered sync endpoint.
   *
   * Unlike the lifecycle hooks this is a *request for external work*, so a provider
   * with no external catalogue **refuses** rather than reporting `NOT_REQUIRED`.
   * Silently accepting would tell an operator their catalogue had been pushed
   * somewhere it had not.
   */
  pushProduct(ctx: ProviderContext, productId: string): Promise<CatalogSyncResult>;

  /**
   * Refresh the local cache from the external catalogue.
   *
   * `performRefresh` is the caller's existing local refresh, passed in as a
   * callback — the same seam as `PostAccounting` and `ReduceStock`. It keeps
   * `ProductsRepository` out of this port entirely: the provider decides *whether*
   * an external catalogue refresh is meaningful, the caller still owns the write.
   *
   * Refuses for a provider with no external catalogue, for the same reason as
   * {@link pushProduct}.
   */
  refreshCatalogue<T>(
    ctx: ProviderContext,
    performRefresh: () => Promise<T>,
  ): Promise<CatalogRefreshOutcome<T>>;
}

/** DI token. */
export const CATALOG_SYNC_PROVIDER_FACTORY = Symbol('CATALOG_SYNC_PROVIDER_FACTORY');
