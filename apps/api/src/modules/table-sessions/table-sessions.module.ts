import { ProvidersModule } from '../providers/providers.module';
import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from '../auth/auth.module';
import { DiningModule } from '../dining/dining.module';
import { KitchenModule } from '../kitchen/kitchen.module';
import { SettingsModule } from '../settings/settings.module';
import { TableSessionsController } from './table-sessions.controller';
import { TableSessionsService } from './table-sessions.service';

@Module({
  // D70 — AuthModule for PermissionResolver: the controller asks whether the
  // caller may see other waiters' sessions.
  imports: [AuthModule, AuditLogModule, KitchenModule, DiningModule, SettingsModule, ProvidersModule],
  controllers: [TableSessionsController],
  providers: [TableSessionsService],
  exports: [TableSessionsService],
})
export class TableSessionsModule {}
