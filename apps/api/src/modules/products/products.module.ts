import { Module } from '@nestjs/common';

import { ProvidersModule } from '../providers/providers.module';
import { ProductsController } from './products.controller';
import { ProductsImportService } from './products-import.service';
import { ProductsReportService } from './products-report.service';
import { ProductsRepository } from './products.repository';
import { ProductsService } from './products.service';

/**
 * `ProvidersModule` replaces `SyncModule` here (Slice 6C-B).
 *
 * Nothing in this module enqueues a sync directly any more: `ProductsService` goes
 * through `CatalogSyncProvider`, and `ProductsImportService` delegates to
 * `ProductsService`. Keeping `SyncModule` would leave the old route open, which is
 * exactly how a second code path survives a refactor.
 */
@Module({
  imports: [ProvidersModule],
  controllers: [ProductsController],
  providers: [ProductsService, ProductsRepository, ProductsImportService, ProductsReportService],
  exports: [ProductsService],
})
export class ProductsModule {}
