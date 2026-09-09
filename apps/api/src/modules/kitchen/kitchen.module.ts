import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { SettingsModule } from '../settings/settings.module';
import { KdsController } from './kds.controller';
import { KitchenPrintersController } from './kitchen-printers.controller';
import { KitchenTicketsController } from './kitchen-tickets.controller';
import { KitchenService } from './kitchen.service';

@Module({
  // D142 — SettingsModule for the tenant's timezone: the Done lane is cut on
  // the SHOP's midnight, not the server's. Settings imports only AuditLogModule,
  // which imports nothing, so this stays a DAG.
  imports: [AuditLogModule, SettingsModule],
  controllers: [KitchenPrintersController, KitchenTicketsController, KdsController],
  providers: [KitchenService],
  exports: [KitchenService],
})
export class KitchenModule {}
