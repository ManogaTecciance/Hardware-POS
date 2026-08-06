import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { TableSessionsController } from './table-sessions.controller';
import { TableSessionsService } from './table-sessions.service';

@Module({
  imports: [AuditLogModule],
  controllers: [TableSessionsController],
  providers: [TableSessionsService],
  exports: [TableSessionsService],
})
export class TableSessionsModule {}
