import { Module } from '@nestjs/common';

import { ProvidersModule } from '../providers/providers.module';
import { ProductImagesController } from './product-images.controller';
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
  imports: [ProvidersModule],
  controllers: [ProductsController, ProductImagesController, ProductVariantsController],
  providers: [
    ProductsService,
    ProductsRepository,
    ProductsImportService,
    ProductsReportService,
    ProductVariantsService,
    ProductVariantsRepository,
  ],
  exports: [ProductsService],
})
export class ProductsModule {}
