import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PlatformAdminRoute } from '../../common/decorators/platform-admin.decorator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/auth.types';
import {
  CreateWorkspaceDto,
  CreateWorkspaceUserDto,
  ResetUserPasswordDto,
  UpdateWorkspaceDto,
  UpdateWorkspaceUserDto,
} from './dto/platform-admin.dto';
import { PlatformAdminService } from './platform-admin.service';

/**
 * D55 — the platform console: workspaces and their user accounts.
 *
 * `@PlatformAdminRoute()` on the class is what `PlatformBoundaryGuard` reads.
 * It is required in both directions — a workspace user is refused here, and a
 * platform admin is refused everywhere else — so the console cannot become a
 * back door into tenant business data by someone adding an endpoint.
 *
 * Audit records are written against the TARGET workspace, not the console's
 * own tenant: the people who need to see "who created this user" are the ones
 * looking at that workspace's trail.
 */
@Controller('platform-admin')
@PlatformAdminRoute()
export class PlatformAdminController {
  constructor(
    private readonly service: PlatformAdminService,
    private readonly audit: AuditLogService,
  ) {}

  @Get('templates')
  templates() {
    return this.service.listTemplates();
  }

  @Get('workspaces')
  listWorkspaces(@Query('search') search?: string) {
    return this.service.listWorkspaces(search?.trim() || undefined);
  }

  @Get('workspaces/:workspaceId')
  getWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.service.getWorkspace(workspaceId);
  }

  @Post('workspaces')
  async createWorkspace(@CurrentUser() actor: AuthenticatedUser, @Body() dto: CreateWorkspaceDto) {
    const created = await this.service.createWorkspace(dto);
    await this.audit.record(created.id, {
      // No workspace user did this. The platform admin is not a member of this
      // tenant, so attributing the record to their id would put a foreign user
      // on the workspace's trail; `byPlatformAdmin` in the metadata is the
      // honest attribution.
      userId: undefined,
      action: 'WORKSPACE_PROVISIONED',
      entityType: 'Tenant',
      entityId: created.id,
      metadata: {
        byPlatformAdmin: actor.id,
        name: created.name,
        slug: created.slug,
        template: created.templateKey,
      },
    });
    return created;
  }

  @Patch('workspaces/:workspaceId')
  async updateWorkspace(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    const updated = await this.service.updateWorkspace(workspaceId, dto);
    await this.audit.record(workspaceId, {
      // No workspace user did this. The platform admin is not a member of this
      // tenant, so attributing the record to their id would put a foreign user
      // on the workspace's trail; `byPlatformAdmin` in the metadata is the
      // honest attribution.
      userId: undefined,
      action: 'WORKSPACE_UPDATED',
      entityType: 'Tenant',
      entityId: workspaceId,
      metadata: { byPlatformAdmin: actor.id, name: updated.name, isActive: updated.isActive },
    });
    return updated;
  }

  @Get('workspaces/:workspaceId/users')
  listUsers(@Param('workspaceId') workspaceId: string) {
    return this.service.listUsers(workspaceId);
  }

  @Post('workspaces/:workspaceId/users')
  async createUser(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateWorkspaceUserDto,
  ) {
    const created = await this.service.createUser(workspaceId, dto);
    await this.audit.record(workspaceId, {
      // No workspace user did this. The platform admin is not a member of this
      // tenant, so attributing the record to their id would put a foreign user
      // on the workspace's trail; `byPlatformAdmin` in the metadata is the
      // honest attribution.
      userId: undefined,
      action: 'WORKSPACE_USER_CREATED',
      entityType: 'User',
      entityId: created.id,
      metadata: { byPlatformAdmin: actor.id, email: created.email, role: created.role },
    });
    return created;
  }

  @Patch('workspaces/:workspaceId/users/:userId')
  async updateUser(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateWorkspaceUserDto,
  ) {
    const updated = await this.service.updateUser(workspaceId, userId, dto);
    await this.audit.record(workspaceId, {
      // No workspace user did this. The platform admin is not a member of this
      // tenant, so attributing the record to their id would put a foreign user
      // on the workspace's trail; `byPlatformAdmin` in the metadata is the
      // honest attribution.
      userId: undefined,
      action: 'WORKSPACE_USER_UPDATED',
      entityType: 'User',
      entityId: userId,
      metadata: { byPlatformAdmin: actor.id, role: updated.role, isActive: updated.isActive },
    });
    return updated;
  }

  /**
   * The one endpoint here that touches credentials.
   *
   * A platform admin who resets a workspace owner's password can then sign in
   * as them, which reaches the business data the boundary guard otherwise
   * refuses — so this is the capability that makes "metadata only" a defence
   * against accident rather than against a malicious operator (D55). It is
   * audited loudly for exactly that reason, and returns nothing: the caller
   * already knows the password they set.
   */
  @Post('workspaces/:workspaceId/users/:userId/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body() dto: ResetUserPasswordDto,
  ): Promise<void> {
    await this.service.resetPassword(workspaceId, userId, dto.password);
    await this.audit.record(workspaceId, {
      // No workspace user did this. The platform admin is not a member of this
      // tenant, so attributing the record to their id would put a foreign user
      // on the workspace's trail; `byPlatformAdmin` in the metadata is the
      // honest attribution.
      userId: undefined,
      action: 'WORKSPACE_USER_PASSWORD_RESET_BY_PLATFORM_ADMIN',
      entityType: 'User',
      entityId: userId,
      metadata: {
        byPlatformAdmin: actor.id,
        // No password material, ever — not the value, not its length.
        note: 'Platform administrator set this user’s password. They can now sign in as this user.',
      },
    });
  }
}
