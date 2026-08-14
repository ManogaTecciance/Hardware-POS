import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/platform.module';
import { SyncModule } from '../sync/sync.module';
import { AccountingProviderFactory } from './accounting/accounting-provider.factory';
import { CatalogSyncProviderFactory } from './catalog/catalog-sync-provider.factory';
import { NoCatalogSyncProvider } from './catalog/no-catalog-sync.provider';
import { QuickBooksCatalogSyncProvider } from './catalog/quickbooks-catalog-sync.provider';
import { NoAccountingProvider } from './accounting/no-accounting.provider';
import { QuickBooksAccountingProvider } from './accounting/quickbooks-accounting.provider';
import { DiningModule } from '../dining/dining.module';
import { FulfilmentProviderFactory } from './fulfilment/fulfilment-provider.factory';
import { ImmediateFulfilmentProvider } from './fulfilment/immediate-fulfilment.provider';
import { TableServiceFulfilmentProvider } from './fulfilment/table-service-fulfilment.provider';
import { InventoryProviderFactory } from './inventory/inventory-provider.factory';
import { LocalInventoryProvider } from './inventory/local-inventory.provider';
import { NoInventoryProvider } from './inventory/no-inventory.provider';
import { QuickBooksInventoryProvider } from './inventory/quickbooks-inventory.provider';

/**
 * Inventory and accounting provider ports, their implementations, and the two
 * factories that resolve one per tenant.
 *
 * **Slice 5 is inert.** This module is deliberately NOT imported into `AppModule`.
 * Nothing in the running application constructs a provider, and every existing
 * sales, returns, products, quotations, payments, and QuickBooks-worker call site
 * is untouched. Registering it globally now would make it possible to start using a
 * provider by accident, which is exactly the risk Slice 5's inertness is meant to
 * remove — Slice 6 imports it as part of the deliberate adoption diff.
 *
 * It is fully constructible in isolation, which is how the tests exercise it: they
 * compile a module graph containing `PrismaModule`, `PlatformModule`, and this one.
 *
 * `SyncModule` is imported because `QuickBooks*Provider` delegates to
 * `SyncQueueService` rather than reimplementing the outbox — that delegation is what
 * guarantees the persisted `SyncJob` and `SyncLog` shapes cannot drift from the ones
 * the repositories write today.
 *
 * `PlatformModule` is imported explicitly even though it is `@Global()`. Global only
 * means "no re-import needed once it is in the graph" — something still has to put
 * it there, and relying on `AppModule` to do so made this module unusable in any
 * smaller graph. The factories genuinely depend on `BusinessProfileService`, so the
 * import states that rather than leaving it to luck.
 *
 * ## Graph prerequisites
 *
 * This module cannot be compiled in total isolation. Both prerequisites are
 * pre-existing couplings of `SyncModule` → `QuickBooksModule`, not ones Slice 5
 * introduced, and both are satisfied automatically inside `AppModule`:
 *
 *  • a **global `JwtModule`** — `QuickBooksService` injects `JwtService` without
 *    importing `JwtModule` itself, relying on the
 *    `JwtModule.registerAsync({ global: true })` that `AuthModule` performs;
 *  • **`StorageModule`** — `QuickBooksModule` imports `SettingsModule`, whose
 *    controller injects `StorageService`.
 *
 * So any graph containing this module also needs `AuthModule` and `StorageModule`.
 * `AppModule` has both, so Slice 6's adoption needs no extra wiring, and
 * `providers.module.spec.ts` imports both for the same reason. Neither is added to
 * the imports below: an inventory/accounting layer declaring a dependency on
 * authentication or file storage would be the wrong architectural statement, and
 * Nest resolves them from the application graph anyway.
 */
@Module({
  // D61: DiningModule for the table-service fulfilment provider's release path.
  imports: [PlatformModule, SyncModule, DiningModule],
  providers: [
    QuickBooksInventoryProvider,
    LocalInventoryProvider,
    NoInventoryProvider,
    InventoryProviderFactory,
    QuickBooksAccountingProvider,
    NoAccountingProvider,
    AccountingProviderFactory,
    QuickBooksCatalogSyncProvider,
    NoCatalogSyncProvider,
    CatalogSyncProviderFactory,
    // D61 — the third provider axis: fulfilment.
    ImmediateFulfilmentProvider,
    TableServiceFulfilmentProvider,
    FulfilmentProviderFactory,
  ],
  exports: [
    InventoryProviderFactory,
    AccountingProviderFactory,
    CatalogSyncProviderFactory,
    FulfilmentProviderFactory,
    ImmediateFulfilmentProvider,
    TableServiceFulfilmentProvider,
  ],
})
export class ProvidersModule {}
