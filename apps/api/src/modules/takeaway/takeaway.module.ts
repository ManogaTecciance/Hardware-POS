import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { KitchenModule } from '../kitchen/kitchen.module';
import { TakeawayController } from './takeaway.controller';
import { TakeawayService } from './takeaway.service';

@Module({
  imports: [AuditLogModule, KitchenModule],
  controllers: [TakeawayController],
  providers: [TakeawayService],
  exports: [TakeawayService],
})
export class TakeawayModule {}
