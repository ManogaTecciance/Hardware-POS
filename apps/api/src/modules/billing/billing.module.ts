import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { TableSessionsModule } from '../table-sessions/table-sessions.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

@Module({
  // D178 — TableSessionsModule: the payment that clears a bill is what frees
  // the table now, and the table lifecycle stays in the service that owns it.
  imports: [AuditLogModule, TableSessionsModule],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
