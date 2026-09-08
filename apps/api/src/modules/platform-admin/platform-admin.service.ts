import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BUSINESS_PROFILE_PRESETS,
  BusinessType,
  Prisma,
  UserRole,
  seedTenantRoles,
} from '@hardware-pos/database';
import * as bcrypt from 'bcryptjs';

import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_MODULES_BY_BUSINESS_TYPE } from '../platform/platform.constants';
import {
  CreateWorkspaceDto,
  CreateWorkspaceUserDto,
  UpdateWorkspaceDto,
  UpdateWorkspaceUserDto,
} from './dto/platform-admin.dto';
import { baseUserRoleFor } from './workspace-roles';
import { WORKSPACE_TEMPLATES, templateByKey } from './workspace-templates';

const SALT_ROUNDS = 10;

/** The console's own tenant. Never listed as a customer workspace. */
export const PLATFORM_TENANT_SLUG = 'platform';

export interface WorkspaceView {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  templateKey: string | null;
  businessType: BusinessType | null;
  userCount: number;
  createdAt: string;
}

export interface WorkspaceUserView {
  id: string;
  name: string;
  email: string | null;
  /** The `UserRole` enum column. Not what grants authority once `roleId` is set. */
  role: UserRole;
  isActive: boolean;
  /**
   * The workspace role in force. Null means the user is on `LEGACY_FALLBACK`
   * resolution — their authority comes from the enum above — which is a real
   * state for accounts created before roles were rows, and one the console
   * shows rather than papers over.
   */
  roleId: string | null;
  roleKey: string | null;
}

export interface WorkspaceRoleView {
  /**
   * The console addresses roles by id, not by key. `Role.key` is nullable —
   * documented as "nullable only so the column could be added without a
   * backfill" — so a key-addressed console would silently be unable to assign
   * any role that lacks one. The id is what `User.roleId` stores anyway.
   */
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  /** A built-in platform role. The template's own roles are not. */
  isSystem: boolean;
}

/**
 * D55 — the platform console.
 *
 * Every method here is administrative metadata: workspaces, their template and
 * their user accounts. Nothing in this service reads a workspace's business
 * data, and `PlatformBoundaryGuard` makes that structural by refusing a
 * platform admin's token on every route outside this module.
 */
@Injectable()
export class PlatformAdminService {
  constructor(private readonly prisma: PrismaService) {}

  listTemplates() {
    return WORKSPACE_TEMPLATES;
  }

  async listWorkspaces(search?: string): Promise<WorkspaceView[]> {
    const rows = await this.prisma.tenant.findMany({
      where: {
        // The console's own tenant is infrastructure, not a customer workspace.
        slug: { not: PLATFORM_TENANT_SLUG },
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { slug: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      include: {
        businessProfile: { select: { businessType: true } },
        _count: { select: { users: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((t) => this.toWorkspaceView(t));
  }

  async getWorkspace(id: string): Promise<WorkspaceView> {
    const row = await this.prisma.tenant.findFirst({
      where: { id, slug: { not: PLATFORM_TENANT_SLUG } },
      include: {
        businessProfile: { select: { businessType: true } },
        _count: { select: { users: true } },
      },
    });
    if (!row) throw new NotFoundException('Workspace not found');
    return this.toWorkspaceView(row);
  }

  /**
   * Create a workspace from a template.
   *
   * One transaction, deliberately: a tenant with no branch, no register, no
   * roles or no owner is not a usable workspace, and a half-built one would
   * have to be repaired by hand in the database.
   */
  async createWorkspace(dto: CreateWorkspaceDto): Promise<WorkspaceView> {
    const template = templateByKey(dto.templateKey);
    if (!template) {
      throw new BadRequestException(
        `Unknown template "${dto.templateKey}". Choose one of: ${WORKSPACE_TEMPLATES.map((t) => t.key).join(', ')}.`,
      );
    }
    const slug = dto.slug.trim().toLowerCase();
    const email = dto.ownerEmail.trim().toLowerCase();

    // Case-insensitive: the value is stored lower-cased (above), so new rows
    // can only collide exactly — but a legacy row with "ABC-abc" must still
    // block "abc-abc", because the two are the same identifier.
    if (
      await this.prisma.tenant.findFirst({
        where: { slug: { equals: slug, mode: 'insensitive' } },
        select: { id: true },
      })
    ) {
      throw new ConflictException(`A workspace with the slug "${slug}" already exists`);
    }
    // Login resolves a user by email across ALL tenants when no workspace is
    // given, so a duplicate would make both accounts ambiguous to sign in to.
    if (await this.prisma.user.findFirst({ where: { email }, select: { id: true } })) {
      throw new ConflictException(`The email ${email} is already in use`);
    }

    const passwordHash = await bcrypt.hash(dto.ownerPassword, SALT_ROUNDS);
    const tenantId = await this.prisma
      .$transaction(async (tx) => {
        const tenant = await tx.tenant.create({ data: { name: dto.name.trim(), slug } });
        await tx.tenantBusinessProfile.create({
          data: {
            tenantId: tenant.id,
            businessType: template.businessType,
            ...BUSINESS_PROFILE_PRESETS[template.businessType],
          },
        });
        // Modules are the template's defaults, written explicitly so the
        // workspace's configuration is inspectable rather than implied.
        const modules = DEFAULT_MODULES_BY_BUSINESS_TYPE[template.businessType];
        await tx.tenantModule.createMany({
          data: modules.map((moduleKey) => ({ tenantId: tenant.id, moduleKey, isEnabled: true })),
        });
        const branch = await tx.branch.create({
          data: { tenantId: tenant.id, name: 'Main Branch', code: 'MAIN' },
        });
        await tx.register.create({
          data: { tenantId: tenant.id, branchId: branch.id, name: 'Register 1', code: 'R1' },
        });
        await seedTenantRoles(tx, tenant.id, template.businessType);
        const owner = await tx.user.create({
          data: {
            tenantId: tenant.id,
            branchId: branch.id,
            name: dto.ownerName.trim(),
            email,
            role: UserRole.OWNER,
            passwordHash,
          },
        });
        // Resolve the owner's authority from the database like every other
        // seeded user, rather than leaving them on the legacy enum fallback.
        const ownerRole = await tx.role.findFirst({
          where: { tenantId: tenant.id, key: 'OWNER' },
          select: { id: true },
        });
        if (ownerRole) {
          await tx.user.update({ where: { id: owner.id }, data: { roleId: ownerRole.id } });
        }
        return tenant.id;
      })
      .catch((err: unknown) => {
        // The slug pre-check above races a concurrent create; `Tenant.slug`
        // is unique at the database, and that loser must see the same 409 as
        // the pre-check — not a raw P2002.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          throw new ConflictException(`A workspace with the slug "${slug}" already exists`);
        }
        throw err;
      });

    return this.getWorkspace(tenantId);
  }

  async updateWorkspace(id: string, dto: UpdateWorkspaceDto): Promise<WorkspaceView> {
    await this.getWorkspace(id);
    await this.prisma.tenant.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    return this.getWorkspace(id);
  }

  /**
   * The roles this workspace can actually assign (D55.1).
   *
   * Read from the workspace's own `Role` rows rather than from the templates,
   * because the rows are what `PermissionResolver` consults and a tenant may
   * have renamed or deactivated one. Which rows exist is decided by the
   * template (2026-08-17): a hardware workspace seeds Owner + Cashier, a
   * food-service one Owner + Waiter + Cashier, a hotel one Owner + Waiter +
   * Receptionist. Workspaces created before the trim keep whatever they were
   * seeded with — this list reflects that, by reading the rows.
   */
  async listRoles(workspaceId: string): Promise<WorkspaceRoleView[]> {
    await this.getWorkspace(workspaceId);
    const rows = await this.prisma.role.findMany({
      where: { tenantId: workspaceId, isActive: true },
      select: { id: true, key: true, name: true, description: true, isSystem: true },
      // Built-ins first, then the template's own roles; alphabetical within each
      // so the list does not reorder itself as roles are renamed.
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return rows;
  }

  async listUsers(workspaceId: string): Promise<WorkspaceUserView[]> {
    await this.getWorkspace(workspaceId);
    const rows = await this.prisma.user.findMany({
      where: { tenantId: workspaceId },
      include: { customRole: { select: { key: true } } },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      isActive: u.isActive,
      roleId: u.roleId,
      roleKey: u.customRole?.key ?? null,
    }));
  }

  async createUser(workspaceId: string, dto: CreateWorkspaceUserDto): Promise<WorkspaceUserView> {
    await this.getWorkspace(workspaceId);
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.findFirst({ where: { email }, select: { id: true } })) {
      throw new ConflictException(`The email ${email} is already in use`);
    }
    const branch = await this.prisma.branch.findFirst({
      where: { tenantId: workspaceId, isActive: true },
      orderBy: { code: 'asc' },
      select: { id: true },
    });
    const role = await this.requireWorkspaceRole(workspaceId, dto.roleId);
    const created = await this.prisma.user.create({
      data: {
        tenantId: workspaceId,
        branchId: branch?.id ?? null,
        name: dto.name.trim(),
        email,
        role: baseUserRoleFor(role.key),
        passwordHash: await bcrypt.hash(dto.password, SALT_ROUNDS),
        roleId: role.id,
      },
      include: { customRole: { select: { key: true } } },
    });
    return {
      id: created.id,
      name: created.name,
      email: created.email,
      role: created.role,
      isActive: created.isActive,
      roleId: created.roleId,
      roleKey: created.customRole?.key ?? null,
    };
  }

  async updateUser(
    workspaceId: string,
    userId: string,
    dto: UpdateWorkspaceUserDto,
  ): Promise<WorkspaceUserView> {
    const user = await this.requireWorkspaceUser(workspaceId, userId);
    const role =
      dto.roleId !== undefined ? await this.requireWorkspaceRole(workspaceId, dto.roleId) : null;
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        // Both columns move together. Leaving the enum behind when the linked
        // role changes is how a demoted OWNER keeps cross-branch visibility.
        ...(role ? { role: baseUserRoleFor(role.key), roleId: role.id } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      include: { customRole: { select: { key: true } } },
    });
    return {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      role: updated.role,
      isActive: updated.isActive,
      roleId: updated.roleId,
      roleKey: updated.customRole?.key ?? null,
    };
  }

  /**
   * The one credential-touching operation in the console. The caller audits it;
   * see D55 on why this is a deliberate hole in the metadata-only boundary.
   */
  async resetPassword(workspaceId: string, userId: string, password: string): Promise<void> {
    const user = await this.requireWorkspaceUser(workspaceId, userId);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(password, SALT_ROUNDS) },
    });
    // Every existing session keeps working until its refresh token expires;
    // revoking them is a separate decision and would sign the user out mid-shift.
  }

  /**
   * Resolve a role key against the workspace's own rows (D55.1).
   *
   * A key that does not belong to this workspace is a 400 naming what does,
   * never a silent `roleId: null`. That fallback was the earlier behaviour and
   * it fails open: an unrecognised key would have left the user on
   * `LEGACY_FALLBACK`, resolving their authority from the enum column — so a
   * typo'd "WAITOR" would have produced a working cashier instead of an error.
   */
  private async requireWorkspaceRole(workspaceId: string, roleId: string) {
    // Scoped by tenantId as well as id, so a role belonging to another
    // workspace cannot be attached even if its id is guessed or copied.
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId: workspaceId, isActive: true },
      select: { id: true, key: true },
    });
    if (role) return role;

    const available = await this.listRoles(workspaceId);
    throw new BadRequestException(
      available.length === 0
        ? 'This workspace has no roles configured, so no role can be assigned.'
        : `That role does not belong to this workspace. Choose one of: ${available
            .map((r) => r.name)
            .join(', ')}.`,
    );
  }

  private async requireWorkspaceUser(workspaceId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId: workspaceId },
      select: { id: true, isPlatformAdmin: true },
    });
    if (!user) throw new NotFoundException('User not found in this workspace');
    // A platform admin is not a workspace member and must not be editable
    // through a workspace-scoped route, which would let one console operator
    // silently reset another's credentials.
    if (user.isPlatformAdmin) throw new NotFoundException('User not found in this workspace');
    return user;
  }

  private toWorkspaceView(row: {
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    createdAt: Date;
    businessProfile: { businessType: BusinessType } | null;
    _count: { users: number };
  }): WorkspaceView {
    const businessType = row.businessProfile?.businessType ?? null;
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      isActive: row.isActive,
      businessType,
      templateKey:
        WORKSPACE_TEMPLATES.find((t) => t.businessType === businessType)?.key ?? null,
      userCount: row._count.users,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

