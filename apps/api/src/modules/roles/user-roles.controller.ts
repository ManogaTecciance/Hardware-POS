import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ModuleKey } from '@hardware-pos/database';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import { AssignRoleDto } from './dto/role.dto';
import { RolesService, type EffectivePermissionsView, type RoleView } from './roles.service';

/**
 * Role assignment and effective-permission reporting.
 *
 * A separate controller *and* a separate file. Nest resolves a base path from the
 * controller's own decorator, so these could not live under `/roles`; and the
 * route-inventory testkit asserts one controller class per controller file, which
 * is what stops a second class hiding inside another's file and escaping the
 * route-module matrix.
 */
@Controller('users')
@RequireModule(ModuleKey.USERS)
export class UserRolesController {
  constructor(
    private readonly roles: RolesService,
    private readonly audit: AuditLogService,
  ) {}

  @Put(':userId/role')
  @RequirePermissions(Permission.USER_MANAGE)
  async assign(
    @TenantId() tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() dto: AssignRoleDto,
  ): Promise<RoleView> {
    const before = await this.roles.effectivePermissions(tenantId, userId);
    const role = await this.roles.assignToUser(tenantId, userId, dto.roleId);
    await this.audit.record(tenantId, {
      userId: actor.id,
      action: 'USER_ROLE_ASSIGNED',
      entityType: 'User',
      entityId: userId,
      metadata: {
        roleId: role.id,
        roleKey: role.key,
        previousSource: before.source,
        selfAssignment: actor.id === userId,
      },
    });
    return role;
  }

  /**
   * What this user's requests actually carry, and from which authority.
   *
   * Readable by an administrator for anyone in the tenant. It is the answer to
   * "why can this person do that", and it reports `LEGACY_FALLBACK` honestly
   * rather than presenting the legacy set as though it came from a role.
   */
  @Get(':userId/effective-permissions')
  @RequirePermissions(Permission.USER_MANAGE)
  effectivePermissions(
    @TenantId() tenantId: string,
    @Param('userId') userId: string,
  ): Promise<EffectivePermissionsView> {
    return this.roles.effectivePermissions(tenantId, userId);
  }
}
