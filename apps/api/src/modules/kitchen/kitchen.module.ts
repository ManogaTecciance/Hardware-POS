import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { KitchenPrintersController } from './kitchen-printers.controller';
import { KitchenTicketsController } from './kitchen-tickets.controller';
import { KitchenService } from './kitchen.service';

@Module({
  imports: [AuditLogModule],
  controllers: [KitchenPrintersController, KitchenTicketsController],
  providers: [KitchenService],
  exports: [KitchenService],
})
export class KitchenModule {}
