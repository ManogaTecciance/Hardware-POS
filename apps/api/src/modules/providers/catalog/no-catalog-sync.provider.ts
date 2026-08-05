import { Injectable } from '@nestjs/common';
import { InventoryMode } from '@hardware-pos/database';

import { ProviderOperationUnavailableError } from '../provider.errors';
import {
  CatalogRefreshOutcome,
  CatalogSyncResult,
  ProductCatalogShape,
  ProviderContext,
} from '../provider.types';
import { CatalogSyncProvider } from './catalog-sync-provider';

/**
 * No external catalogue: products exist only in AxloPOS.
 *
 * Serves `LOCAL` and `DISABLED` inventory. `mode` reports `LOCAL` because a class
 * has one identity and the factory maps both modes here — the factory is the
 * authority on which mode resolved, and `providers.spec.ts` asserts both do.
 *
 * ## The structural guarantee
 *
 * It has **no constructor**, so it holds no `PrismaService` and no
 * `SyncQueueService`. "Creates no SyncJob, no SyncLog, no QuickBooks item id, and
 * makes no external call" is therefore not a behaviour to be tested for — it is
 * something this class has no mechanism to do. A contract test asserts the absence
 * of the constructor, which is what makes that guarantee durable.
 *
 * The lifecycle hooks return `NOT_REQUIRED`: the local product is complete and
 * usable, and nothing needed synchronising. That is a success, and it must never be
 * rendered as "not synced to QuickBooks".
 *
 * The **explicit** operations refuse instead. Accepting a push request and quietly
 * doing nothing would tell an operator their catalogue reached a system it never
 * did — the same class of lie as a fabricated document id.
 */
@Injectable()
export class NoCatalogSyncProvider implements CatalogSyncProvider {
  readonly mode = InventoryMode.LOCAL;
  readonly name = 'No external catalogue';

  productCreated(_ctx: ProviderContext, _product: ProductCatalogShape): Promise<CatalogSyncResult> {
    return Promise.resolve({ disposition: 'NOT_REQUIRED', provider: 'NONE' });
  }

  productUpdated(
    _ctx: ProviderContext,
    _before: ProductCatalogShape,
    _after: ProductCatalogShape,
  ): Promise<CatalogSyncResult> {
    return Promise.resolve({ disposition: 'NOT_REQUIRED', provider: 'NONE' });
  }

  productDeactivated(
    _ctx: ProviderContext,
    _product: ProductCatalogShape,
  ): Promise<CatalogSyncResult> {
    return Promise.resolve({ disposition: 'NOT_REQUIRED', provider: 'NONE' });
  }

  /** Refuses: there is no external catalogue to push to. */
  pushProduct(_ctx: ProviderContext, _productId: string): Promise<CatalogSyncResult> {
    return Promise.reject(
      new ProviderOperationUnavailableError(this.name, 'pushing a product to an external catalogue'),
    );
  }

  /** Refuses: there is no external catalogue to refresh from. */
  refreshCatalogue<T>(
    _ctx: ProviderContext,
    _performRefresh: () => Promise<T>,
  ): Promise<CatalogRefreshOutcome<T>> {
    return Promise.reject(
      new ProviderOperationUnavailableError(this.name, 'refreshing from an external catalogue'),
    );
  }
}
