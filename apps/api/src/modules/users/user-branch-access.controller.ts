import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Put,
} from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { GrantBranchAccessDto } from './dto/grant-branch-access.dto';
import { UsersService, type UserBranchAccessView } from './users.service';

/**
 * Per-user branch access management, Phase 1.5.6.
 *
 * A separate controller class in a separate file — the route-inventory
 * testkit asserts one controller class per file, and the D30 rule against
 * silent vacuity relies on that. Grants and revocations are audited so a
 * later investigation can reconstruct who could see which branch on which
 * day (the change is what makes the difference visible, not the current
 * state).
 */
@Controller('users')
@RequireModule(ModuleKey.USERS)
export class UserBranchAccessController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * The branches this user is currently allowed into — the caller's view of
   * what an administrator has granted. OWNER/ADMIN users show `roleGrant`
   * (implicit through their role) so the response never lies about *why*
   * they can access something.
   */
  @Get(':userId/branch-access')
  @RequirePermissions(Permission.USER_MANAGE)
  list(
    @TenantId() tenantId: string,
    @Param('userId') userId: string,
  ): Promise<UserBranchAccessView> {
    return this.users.listBranchAccess(tenantId, userId);
  }

  /**
   * Grant the user access to a branch. Idempotent — an existing grant returns
   * 200 with no new row. A branch in another tenant answers 404, never 403.
   */
  @Put(':userId/branch-access/:branchId')
  @RequirePermissions(Permission.USER_MANAGE)
  async grant(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId') userId: string,
    @Param('branchId') branchId: string,
    @Body() dto: GrantBranchAccessDto,
  ): Promise<UserBranchAccessView> {
    if (dto.confirm !== true) {
      // A body is required so the grant is a deliberate act — a fat-finger
      // PUT with just a URL cannot silently escalate a user.
      throw new BadRequestException('Confirmation flag required');
    }
    const before = await this.users.listBranchAccess(tenantId, userId);
    const after = await this.users.grantBranchAccess(tenantId, userId, branchId, actor.id);
    const wasNew = !before.explicitGrants.some((g) => g.branchId === branchId);
    if (wasNew) {
      await this.audit.record(tenantId, {
        userId: actor.id,
        action: 'USER_BRANCH_ACCESS_GRANTED',
        entityType: 'User',
        entityId: userId,
        metadata: { branchId },
      });
    }
    return after;
  }

  /**
   * Revoke a granted branch. Fails when the user has no other access at all
   * (would lock them out of every operational route). OWNER/ADMIN cannot be
   * revoked here — they gain access through their role and this table does
   * not gate them.
   */
  @Delete(':userId/branch-access/:branchId')
  @RequirePermissions(Permission.USER_MANAGE)
  async revoke(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId') userId: string,
    @Param('branchId') branchId: string,
  ): Promise<UserBranchAccessView> {
    const result = await this.users.revokeBranchAccess(tenantId, userId, branchId);
    if (!result.removed) {
      throw new NotFoundException('Grant not found');
    }
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'USER_BRANCH_ACCESS_REVOKED',
      entityType: 'User',
      entityId: userId,
      metadata: { branchId },
    });
    return result.view;
  }
}
