import { Module } from '@nestjs/common';

import { ProvidersModule } from '../providers/providers.module';
import { StockTakesController } from './stock-takes.controller';
import { StockTakesService } from './stock-takes.service';

/**
 * Stock takes / cycle counts (D132).
 *
 * Imports `ProvidersModule` because the service resolves
 * `InventoryProvider.applyStockCount` rather than writing stock itself — the
 * same seam receiving uses, so there is still exactly one layer that moves
 * stock.
 */
@Module({
  imports: [ProvidersModule],
  controllers: [StockTakesController],
  providers: [StockTakesService],
  exports: [StockTakesService],
})
export class StockTakesModule {}
