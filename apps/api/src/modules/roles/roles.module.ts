import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from '../auth/auth.module';
import { RolesController } from './roles.controller';
import { UserRolesController } from './user-roles.controller';
import { RolesService } from './roles.service';

/** Tenant role and assignment management (Phase 1.5.5). */
@Module({
  imports: [AuditLogModule, AuthModule],
  controllers: [RolesController, UserRolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
