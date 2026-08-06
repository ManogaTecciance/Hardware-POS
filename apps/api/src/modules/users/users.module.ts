import { Module } from '@nestjs/common';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { UserBranchAccessController } from './user-branch-access.controller';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  imports: [AuditLogModule],
  controllers: [UsersController, UserBranchAccessController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService],
})
export class UsersModule {}
