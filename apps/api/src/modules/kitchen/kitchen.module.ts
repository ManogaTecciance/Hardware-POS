import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { PrintingModule } from '../printing/printing.module';
import { KdsController } from './kds.controller';
import { KitchenPrintersController } from './kitchen-printers.controller';
import { KitchenTicketsController } from './kitchen-tickets.controller';
import { KitchenService } from './kitchen.service';

@Module({
  imports: [AuditLogModule, PrintingModule],
  controllers: [KitchenPrintersController, KitchenTicketsController, KdsController],
  providers: [KitchenService],
  exports: [KitchenService],
})
export class KitchenModule {}
