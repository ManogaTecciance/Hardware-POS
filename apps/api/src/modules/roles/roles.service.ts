import { Injectable } from '@nestjs/common';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from '@hardware-pos/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { Permission } from '../auth/permissions';
import { PermissionResolver } from '../auth/permission-resolver.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  BuiltInRoleImmutableError,
  RoleArchivedError,
  RoleKeyTakenError,
  RoleNotFoundError,
  RoleStillAssignedError,
  RoleVersionConflictError,
  TenantAdministrationLockoutError,
  UnknownPermissionError,
} from './roles.errors';

const CATALOGUE = new Set<string>(ALL_PERMISSIONS);

/**
 * The permissions that constitute "can administer this workspace".
 *
 * A tenant must always retain an active user holding **both**. Losing either
 * strands the workspace: without `USER_MANAGE` nobody can appoint a replacement,
 * and without `PLATFORM_PROFILE_MANAGE` nobody can change what the workspace runs.
 * There is no super-admin in this product, so recovery would mean support editing
 * the database by hand.
 */
const ADMINISTRATION_PERMISSIONS: readonly Permission[] = [
  Permission.USER_MANAGE,
  Permission.PLATFORM_PROFILE_MANAGE,
];

export interface RoleView {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  isBuiltIn: boolean;
  isActive: boolean;
  version: number;
  permissions: Permission[];
  assignedUserCount: number;
}

export interface EffectivePermissionsView {
  userId: string;
  source: 'DATABASE' | 'LEGACY_FALLBACK' | 'DENIED';
  reason?: string;
  permissions: Permission[];
}

/**
 * Tenant role and assignment management (Phase 1.5.5).
 *
 * Every method takes `tenantId` from the authenticated session — never from a
 * body or query — and every query filters on it. A role id belonging to another
 * tenant does not resolve, so there is no request shape that reaches one.
 *
 * ## Roles are never deleted
 *
 * Per the Product Owner: custom roles archive, built-in roles do neither. An
 * archived role keeps its historical assignments and audit references, cannot be
 * assigned to anyone new, and fails closed for any user still holding it. Keys are
 * never reused, so an audit entry naming a key always names the same role.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
  ) {}

  async list(tenantId: string, includeArchived = false): Promise<RoleView[]> {
    const roles = await this.prisma.role.findMany({
      where: { tenantId, ...(includeArchived ? {} : { isActive: true }) },
      include: { permissions: { select: { key: true } }, _count: { select: { users: true } } },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return roles.map((role) => this.toView(role));
  }

  async get(tenantId: string, roleId: string): Promise<RoleView> {
    return this.toView(await this.loadOrThrow(tenantId, roleId));
  }

  async create(
    tenantId: string,
    input: { key: string; name: string; description?: string; permissions: string[] },
  ): Promise<RoleView> {
    const permissions = this.validatePermissions(input.permissions);

    // Keys are never reused, so an archived role's key still blocks a new one.
    const clash = await this.prisma.role.findFirst({
      where: { tenantId, key: input.key },
      select: { id: true },
    });
    if (clash) throw new RoleKeyTakenError(input.key);

    const created = await this.prisma.role.create({
      data: {
        tenantId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        // A tenant-created role is never a system role. Only seeding creates those.
        isSystem: false,
        permissions: { connect: permissions.map((key) => ({ key })) },
      },
      include: { permissions: { select: { key: true } }, _count: { select: { users: true } } },
    });
    return this.toView(created);
  }

  /** Presentation only. `key`, `isSystem` and `isActive` are not editable here. */
  async update(
    tenantId: string,
    roleId: string,
    input: { name?: string; description?: string; expectedVersion?: number },
  ): Promise<RoleView> {
    const role = await this.loadOrThrow(tenantId, roleId);
    this.assertVersion(role.version, input.expectedVersion);
    if (!role.isActive) throw new RoleArchivedError();

    const updated = await this.prisma.role.update({
      where: { id: role.id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        version: { increment: 1 },
      },
      include: { permissions: { select: { key: true } }, _count: { select: { users: true } } },
    });
    return this.toView(updated);
  }

  /**
   * Replaces a role's permissions wholesale.
   *
   * `set` rather than `connect`: a removal that did not remove would be the whole
   * point of this endpoint failing silently.
   */
  async replacePermissions(
    tenantId: string,
    roleId: string,
    keys: string[],
    expectedVersion?: number,
  ): Promise<RoleView> {
    const permissions = this.validatePermissions(keys);
    const role = await this.loadOrThrow(tenantId, roleId);
    this.assertVersion(role.version, expectedVersion);
    if (!role.isActive) throw new RoleArchivedError();

    // Built-in permission sets are the parity baseline the legacy authority is
    // compared against. Editing one would make `role-authority-report` report a
    // difference forever and quietly change what OWNER means.
    if (role.isSystem) throw new BuiltInRoleImmutableError('have its permissions changed');

    await this.assertAdministrationSurvives(tenantId, {
      roleId: role.id,
      nextPermissions: permissions,
    });

    const updated = await this.prisma.role.update({
      where: { id: role.id },
      data: {
        permissions: { set: permissions.map((key) => ({ key })) },
        version: { increment: 1 },
      },
      include: { permissions: { select: { key: true } }, _count: { select: { users: true } } },
    });
    return this.toView(updated);
  }

  async archive(tenantId: string, roleId: string, expectedVersion?: number): Promise<RoleView> {
    const role = await this.loadOrThrow(tenantId, roleId);
    this.assertVersion(role.version, expectedVersion);
    if (role.isSystem) throw new BuiltInRoleImmutableError('be archived');

    // Reassign first. Archiving out from under live users would leave them
    // failing closed with no explanation and no path back.
    const assigned = await this.prisma.user.count({
      where: { tenantId, roleId: role.id, isActive: true },
    });
    if (assigned > 0) throw new RoleStillAssignedError(assigned);

    const updated = await this.prisma.role.update({
      where: { id: role.id },
      data: { isActive: false, version: { increment: 1 } },
      include: { permissions: { select: { key: true } }, _count: { select: { users: true } } },
    });
    return this.toView(updated);
  }

  /** Assigns a role to a user. Both must belong to the authenticated tenant. */
  async assignToUser(tenantId: string, userId: string, roleId: string): Promise<RoleView> {
    const role = await this.loadOrThrow(tenantId, roleId);
    if (!role.isActive) throw new RoleArchivedError();

    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, roleId: true },
    });
    // Same reasoning as a foreign role: a user in another tenant is "not found".
    if (!user) throw new RoleNotFoundError(userId);

    await this.assertAdministrationSurvives(tenantId, {
      movingUserId: user.id,
      toRoleId: role.id,
    });

    await this.prisma.user.update({ where: { id: user.id }, data: { roleId: role.id } });
    return this.get(tenantId, role.id);
  }

  /**
   * What a user's requests actually carry, and from which authority.
   *
   * Deliberately routed through the same `PermissionResolver` the guard uses. A
   * second implementation for reporting would eventually disagree with the one
   * that enforces, and the report is most trusted exactly when it is wrong.
   */
  async effectivePermissions(tenantId: string, userId: string): Promise<EffectivePermissionsView> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, tenantId: true, role: true },
    });
    if (!user) throw new RoleNotFoundError(userId);

    const authority = await this.resolver.resolve(user as AuthenticatedUser);
    return {
      userId: user.id,
      source: authority.source,
      reason: authority.reason,
      permissions: [...authority.permissions].sort(),
    };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async loadOrThrow(tenantId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId },
      include: { permissions: { select: { key: true } }, _count: { select: { users: true } } },
    });
    if (!role) throw new RoleNotFoundError(roleId);
    return role;
  }

  private validatePermissions(keys: string[]): Permission[] {
    const unknown = keys.filter((key) => !CATALOGUE.has(key));
    if (unknown.length > 0) throw new UnknownPermissionError(unknown);
    // De-duplicated: `set` with repeats is harmless but the stored result would
    // not match what the caller sent, and the response should be the truth.
    return [...new Set(keys)] as Permission[];
  }

  private assertVersion(actual: number, expected?: number): void {
    if (expected !== undefined && expected !== actual) {
      throw new RoleVersionConflictError(expected, actual);
    }
  }

  /**
   * Refuses a change that would leave the tenant with no administrator.
   *
   * Computed over the state *after* the proposed change, across every active user,
   * from whichever authority each of them resolves through — a tenant whose only
   * remaining administrator is an unmigrated user on the legacy path is still
   * administered, and refusing that would be wrong.
   */
  private async assertAdministrationSurvives(
    tenantId: string,
    change: {
      roleId?: string;
      nextPermissions?: Permission[];
      movingUserId?: string;
      toRoleId?: string;
    },
  ): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        role: true,
        roleId: true,
        customRole: { select: { id: true, isActive: true, permissions: { select: { key: true } } } },
      },
    });

    const targetRolePermissions = change.toRoleId
      ? (
          await this.prisma.role.findFirst({
            where: { id: change.toRoleId, tenantId },
            select: { permissions: { select: { key: true } } },
          })
        )?.permissions.map((p) => p.key) ?? []
      : [];

    const stillAdministered = users.some((user) => {
      let permissions: string[];

      if (change.movingUserId === user.id) {
        permissions = targetRolePermissions;
      } else if (user.roleId && user.roleId === change.roleId && change.nextPermissions) {
        permissions = change.nextPermissions;
      } else if (user.roleId) {
        permissions = user.customRole?.isActive
          ? user.customRole.permissions.map((p) => p.key)
          : [];
      } else {
        permissions = [...ROLE_PERMISSIONS[user.role]];
      }

      return ADMINISTRATION_PERMISSIONS.every((needed) => permissions.includes(needed));
    });

    if (!stillAdministered) {
      throw new TenantAdministrationLockoutError('That change would remove the last administrator.');
    }
  }

  private toView(role: {
    id: string;
    key: string | null;
    name: string;
    description: string | null;
    isSystem: boolean;
    isActive: boolean;
    version: number;
    permissions: { key: string }[];
    _count: { users: number };
  }): RoleView {
    return {
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isBuiltIn: role.isSystem,
      isActive: role.isActive,
      version: role.version,
      permissions: role.permissions.map((p) => p.key).sort() as Permission[],
      assignedUserCount: role._count.users,
    };
  }
}
