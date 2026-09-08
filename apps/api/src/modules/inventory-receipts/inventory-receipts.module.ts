import { Module } from '@nestjs/common';

import { ProvidersModule } from '../providers/providers.module';
import { InventoryReceiptsController } from './inventory-receipts.controller';
import { InventoryReceiptsRepository } from './inventory-receipts.repository';
import { InventoryReceiptsService } from './inventory-receipts.service';

/**
 * Purchase Receipts / Receive Stock (D44).
 *
 * Imports `ProvidersModule` because the service resolves the tenant's
 * `InventoryProvider.receiveStock` — the same code path opening stock uses
 * during the product-variant wizard, so weighted-average cost has one
 * implementation across every entry point.
 */
@Module({
  imports: [ProvidersModule],
  controllers: [InventoryReceiptsController],
  providers: [InventoryReceiptsService, InventoryReceiptsRepository],
  exports: [InventoryReceiptsService],
})
export class InventoryReceiptsModule {}
