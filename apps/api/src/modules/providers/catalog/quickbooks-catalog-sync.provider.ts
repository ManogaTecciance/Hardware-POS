import { Injectable } from '@nestjs/common';
import { InventoryMode } from '@hardware-pos/database';

import { SyncQueueService } from '../../sync/queue/sync-queue.service';
import {
  CatalogRefreshOutcome,
  CatalogSyncResult,
  ProductCatalogShape,
  ProviderContext,
} from '../provider.types';
import { CatalogSyncProvider } from './catalog-sync-provider';

/**
 * QuickBooks Online as the product catalogue — today's production behaviour,
 * adapted to the port with no change in outcome.
 *
 * Every rule was read out of `products.service.ts` rather than re-derived:
 *
 *  • `create` → `queueQuickBooksPush` **unconditionally**.
 *  • `update` → push only when the product is already linked
 *    (`quickbooksItemId != null`) **and** a mirrored field changed.
 *  • `deactivate` → push only when the product is already linked.
 *  • `syncToQuickBooks` → enqueue, and throw when nothing was queued.
 *
 * Row shapes cannot drift: like the accounting provider, this writes `SyncJob` and
 * `SyncLog` only by delegating to `SyncQueueService.enqueueProductSync`, the exact
 * call `ProductsService` makes today. There is no second code path.
 *
 * It never writes a `Product` row. `syncStatus: 'PENDING'` remains the caller's
 * consequence of a `QUEUED` disposition, so local persistence stays in one place.
 */
@Injectable()
export class QuickBooksCatalogSyncProvider implements CatalogSyncProvider {
  readonly mode = InventoryMode.QUICKBOOKS;
  readonly name = 'QuickBooks catalogue';

  constructor(private readonly syncQueue: SyncQueueService) {}

  /** A new product always attempts a push, exactly as `create` does today. */
  productCreated(ctx: ProviderContext, product: ProductCatalogShape): Promise<CatalogSyncResult> {
    return this.enqueue(ctx, product.id);
  }

  /**
   * A linked product whose mirrored fields changed is pushed; anything else is not.
   *
   * `NOT_CONNECTED` is the honest answer for "no push was needed": nothing was
   * queued, and the caller must leave the sync status alone — which is precisely
   * what today's `update` does when the condition is false.
   */
  productUpdated(
    ctx: ProviderContext,
    before: ProductCatalogShape,
    after: ProductCatalogShape,
  ): Promise<CatalogSyncResult> {
    if (before.externalItemId === null || !mirroredFieldsChanged(before, after)) {
      return Promise.resolve({ disposition: 'NOT_CONNECTED', provider: 'QUICKBOOKS' });
    }
    return this.enqueue(ctx, after.id);
  }

  /** Deactivating a linked product marks the QuickBooks item inactive too. */
  productDeactivated(
    ctx: ProviderContext,
    product: ProductCatalogShape,
  ): Promise<CatalogSyncResult> {
    if (product.externalItemId === null) {
      return Promise.resolve({ disposition: 'NOT_CONNECTED', provider: 'QUICKBOOKS' });
    }
    return this.enqueue(ctx, product.id);
  }

  /** The explicit endpoint. Same enqueue; the caller still raises its own error. */
  pushProduct(ctx: ProviderContext, productId: string): Promise<CatalogSyncResult> {
    return this.enqueue(ctx, productId);
  }

  /** QuickBooks does have a catalogue to refresh from, so run the caller's refresh. */
  async refreshCatalogue<T>(
    _ctx: ProviderContext,
    performRefresh: () => Promise<T>,
  ): Promise<CatalogRefreshOutcome<T>> {
    return { disposition: 'REFRESHED', provider: 'QUICKBOOKS', summary: await performRefresh() };
  }

  /**
   * `enqueueProductSync` returns falsy when no company is connected. That is
   * reported rather than thrown, because the two existing call sites treat it
   * differently — `create`/`update` shrug, the explicit endpoint raises.
   */
  private async enqueue(ctx: ProviderContext, productId: string): Promise<CatalogSyncResult> {
    const queued = await this.syncQueue.enqueueProductSync(ctx.tenantId, productId);
    return queued
      ? { disposition: 'QUEUED', provider: 'QUICKBOOKS' }
      : { disposition: 'NOT_CONNECTED', provider: 'QUICKBOOKS' };
  }
}

/**
 * Did any field QuickBooks mirrors change?
 *
 * Lifted verbatim from `ProductsService.qboFieldsChanged`, including the numeric
 * normalisation that stops a Decimal/number difference from looking like an edit.
 * Exported so a test can pin it against the original list field by field.
 */
export function mirroredFieldsChanged(
  before: ProductCatalogShape,
  after: ProductCatalogShape,
): boolean {
  const num = (v: number | null): number | null => (v == null ? null : Number(v));
  return (
    before.name !== after.name ||
    before.type !== after.type ||
    before.sku !== after.sku ||
    before.description !== after.description ||
    before.purchaseDescription !== after.purchaseDescription ||
    num(before.unitPrice) !== num(after.unitPrice) ||
    num(before.costPrice) !== num(after.costPrice) ||
    before.isActive !== after.isActive
  );
}
