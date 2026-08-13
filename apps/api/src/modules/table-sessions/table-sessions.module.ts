import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { DiningModule } from '../dining/dining.module';
import { KitchenModule } from '../kitchen/kitchen.module';
import { SettingsModule } from '../settings/settings.module';
import { TableSessionsController } from './table-sessions.controller';
import { TableSessionsService } from './table-sessions.service';

@Module({
  imports: [AuditLogModule, KitchenModule, DiningModule, SettingsModule],
  controllers: [TableSessionsController],
  providers: [TableSessionsService],
  exports: [TableSessionsService],
})
export class TableSessionsModule {}
