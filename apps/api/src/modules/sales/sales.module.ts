import { Module } from '@nestjs/common';

import { DiscountsModule } from '../discounts/discounts.module';
import { ProvidersModule } from '../providers/providers.module';
import { SettingsModule } from '../settings/settings.module';
import { SyncModule } from '../sync/sync.module';
import { SalesController } from './sales.controller';
import { SalesReportService } from './sales-report.service';
import { SalesRepository } from './sales.repository';
import { SalesService } from './sales.service';

/**
 * Slice 6A wires `ProvidersModule` into the live graph for the first time, and
 * deliberately only here — the narrowest module that needs it. Returns, products,
 * quotations, and the QuickBooks workers still do not import it, so a provider
 * cannot be adopted elsewhere by accident just because the module is now live.
 *
 * `SyncModule` stays imported: `SalesRepository` still uses `SyncQueueService` for
 * the retry/requeue paths that Slice 6A does not touch.
 */
@Module({
  imports: [SettingsModule, DiscountsModule, SyncModule, ProvidersModule],
  controllers: [SalesController],
  providers: [SalesService, SalesRepository, SalesReportService],
  exports: [SalesService],
})
export class SalesModule {}
