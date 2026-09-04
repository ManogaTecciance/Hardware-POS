import { Module } from '@nestjs/common';

import { DiscountsModule } from '../discounts/discounts.module';
import { CreditModule } from '../credit/credit.module';
import { SettingsModule } from '../settings/settings.module';
import { SyncModule } from '../sync/sync.module';
import { SalesController } from './sales.controller';
import { SalesReportService } from './sales-report.service';
import { SalesRepository } from './sales.repository';
import { SalesService } from './sales.service';

@Module({
  imports: [SettingsModule, DiscountsModule, SyncModule, CreditModule],
  controllers: [SalesController],
  providers: [SalesService, SalesRepository, SalesReportService],
  exports: [SalesService],
})
export class SalesModule {}
