import { ProvidersModule } from '../providers/providers.module';
import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { KitchenModule } from '../kitchen/kitchen.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { SettingsModule } from '../settings/settings.module';
import { TakeawayController } from './takeaway.controller';
import { TakeawayService } from './takeaway.service';

@Module({
  imports: [AuditLogModule, KitchenModule, SettingsModule, ProvidersModule, PromotionsModule],
  controllers: [TakeawayController],
  providers: [TakeawayService],
  exports: [TakeawayService],
})
export class TakeawayModule {}
