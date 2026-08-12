import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { ProvidersModule } from '../providers/providers.module';
import { ProductImagesController } from './product-images.controller';
import { ProductModifiersController } from './product-modifiers.controller';
import { ProductModifiersService } from './product-modifiers.service';
import { ProductStationsController } from './product-stations.controller';
import { ProductStationsService } from './product-stations.service';
import { ProductsController } from './products.controller';
import { ProductsImportService } from './products-import.service';
import { ProductsReportService } from './products-report.service';
import { ProductsRepository } from './products.repository';
import { ProductsService } from './products.service';
import { ProductVariantsController } from './variants/product-variants.controller';
import { ProductVariantsRepository } from './variants/product-variants.repository';
import { ProductVariantsService } from './variants/product-variants.service';

/**
 * `ProvidersModule` replaces `SyncModule` here (Slice 6C-B).
 *
 * Nothing in this module enqueues a sync directly any more: `ProductsService` goes
 * through `CatalogSyncProvider`, and `ProductsImportService` delegates to
 * `ProductsService`. Keeping `SyncModule` would leave the old route open, which is
 * exactly how a second code path survives a refactor.
 *
 * D44 adds the variants controller/service/repository so the wizard's endpoints
 * live in the same module tree as the products they hang off. `ProductVariants
 * Service` holds `InventoryProviderFactory` (imported transitively via
 * `ProvidersModule`) because the batch-create-with-opening-stock path routes
 * through the same `receiveStock` pipeline as a real GRN — the whole point of
 * having ONE weighted-average code path.
 */
@Module({
  // AuditLogModule is imported for D45: the Product ↔ ModifierGroup and
  // Product ↔ KitchenStation attachment endpoints record a mutation audit
  // event so the wizard's changes are traceable per-tenant.
  imports: [ProvidersModule, AuditLogModule],
  controllers: [
    ProductsController,
    ProductImagesController,
    ProductVariantsController,
    // D45 — Product-side attachment endpoints. ModifierGroup / KitchenStation
    // catalogues stay owned by their respective modules; only the junctions
    // live here.
    ProductModifiersController,
    ProductStationsController,
  ],
  providers: [
    ProductsService,
    ProductsRepository,
    ProductsImportService,
    ProductsReportService,
    ProductVariantsService,
    ProductVariantsRepository,
    ProductModifiersService,
    ProductStationsService,
  ],
  exports: [ProductsService],
})
export class ProductsModule {}
