import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { ModuleKey } from '@hardware-pos/database';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { Permission } from '../auth/permissions';
import {
  ArchiveRoleDto,
  CreateRoleDto,
  ReplaceRolePermissionsDto,
  UpdateRoleDto,
} from './dto/role.dto';
import { RolesService, type RoleView } from './roles.service';

/**
 * Tenant role management (Phase 1.5.5).
 *
 * The tenant is always the authenticated caller's own — `@TenantId()` resolves it
 * from the verified session and no route accepts one as a parameter, query or body
 * field. There is no cross-tenant listing and no tenant-selection parameter.
 *
 * Gated on `USER_MANAGE` rather than on a role *name*: permissions are the
 * authorization authority, so a tenant that renames "Administrator" or builds its
 * own administrative role keeps working. Reads are gated the same way — a role
 * list is a map of who can do what, which is not ordinary staff information.
 *
 * `@RequireModule(USERS)` because this is user administration, and a tenant
 * without the module has no user management at all.
 */
@Controller('roles')
@RequireModule(ModuleKey.USERS)
@RequirePermissions(Permission.USER_MANAGE)
export class RolesController {
  constructor(
    private readonly roles: RolesService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  list(
    @TenantId() tenantId: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<RoleView[]> {
    return this.roles.list(tenantId, includeArchived === 'true');
  }

  @Get(':roleId')
  get(@TenantId() tenantId: string, @Param('roleId') roleId: string): Promise<RoleView> {
    return this.roles.get(tenantId, roleId);
  }

  @Post()
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRoleDto,
  ): Promise<RoleView> {
    const role = await this.roles.create(tenantId, dto);
    await this.audit.record(tenantId, {
      userId: user.id,
      action: 'ROLE_CREATED',
      entityType: 'Role',
      entityId: role.id,
      // Permission keys are configuration, not secrets — they are the whole point
      // of the record. Nothing here carries a credential.
      metadata: { key: role.key, name: role.name, permissions: role.permissions },
    });
    return role;
  }

  @Patch(':roleId')
  async update(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('roleId') roleId: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<RoleView> {
    const before = await this.roles.get(tenantId, roleId);
    const role = await this.roles.update(tenantId, roleId, dto);
    await this.audit.record(tenantId, {
      userId: user.id,
      action: 'ROLE_UPDATED',
      entityType: 'Role',
      entityId: role.id,
      metadata: {
        key: role.key,
        previous: { name: before.name, description: before.description },
        next: { name: role.name, description: role.description },
      },
    });
    return role;
  }

  @Put(':roleId/permissions')
  async replacePermissions(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('roleId') roleId: string,
    @Body() dto: ReplaceRolePermissionsDto,
  ): Promise<RoleView> {
    const before = await this.roles.get(tenantId, roleId);
    const role = await this.roles.replacePermissions(
      tenantId,
      roleId,
      dto.permissions,
      dto.expectedVersion,
    );

    // Granted and revoked are recorded separately. "The set is now X" does not
    // answer "what did this change take away", which is the question asked after
    // an incident.
    const granted = role.permissions.filter((p) => !before.permissions.includes(p));
    const revoked = before.permissions.filter((p) => !role.permissions.includes(p));
    await this.audit.record(tenantId, {
      userId: user.id,
      action: 'ROLE_PERMISSIONS_REPLACED',
      entityType: 'Role',
      entityId: role.id,
      metadata: { key: role.key, granted, revoked, permissions: role.permissions },
    });
    return role;
  }

  @Post(':roleId/archive')
  async archive(
    @TenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('roleId') roleId: string,
    @Body() dto: ArchiveRoleDto,
  ): Promise<RoleView> {
    const role = await this.roles.archive(tenantId, roleId, dto.expectedVersion);
    await this.audit.record(tenantId, {
      userId: user.id,
      action: 'ROLE_ARCHIVED',
      entityType: 'Role',
      entityId: role.id,
      metadata: { key: role.key, name: role.name },
    });
    return role;
  }
}
