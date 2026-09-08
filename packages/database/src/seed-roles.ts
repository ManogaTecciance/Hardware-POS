/**
 * Clones the approved role templates into a tenant (Phase 1.5, D36/D37).
 *
 * Used by `prisma/seed.ts` and `prisma/provision-tenant.ts` so a tenant created by
 * either route ends up with the same roles. A tenant with no role rows must fail
 * closed once authorization reads them, so seeding is part of creating a tenant,
 * not an optional extra.
 *
 * ## What reads these rows
 *
 * `PermissionResolver` (apps/api), on every request: a user with `roleId` set
 * resolves from their row (DATABASE); a user with none resolves from
 * `ROLE_PERMISSIONS[User.role]` (LEGACY_FALLBACK). Phase 1.5.1 landed the rows
 * inert and Phase 1.5.4 switched resolution over once parity was proven;
 * `linkUsersToRoles` below is what moves a user from the second path to the
 * first, and `provision-tenant.ts`, the platform console and
 * `backfill-tenant-roles.ts` all run it.
 *
 * ## Permission rows
 *
 * `Permission` is a mirror of the code catalogue, not a second authority (D37).
 * Rows are upserted from `ALL_PERMISSIONS` so assignments can reference them by
 * foreign key; a key absent from the catalogue is never written, so an unknown
 * permission cannot enter the database and later be granted by accident.
 */
import type { PrismaClient } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  roleTemplatesForBusinessType,
  type RoleTemplate,
} from '@hardware-pos/shared';

/** Minimal surface so a transaction client is accepted as readily as the client. */
type Db = Pick<PrismaClient, 'permission' | 'role'>;
type DbWithUsers = Db & Pick<PrismaClient, 'user'>;

/**
 * Ensures every catalogue permission exists as a row. Idempotent, and global
 * rather than per-tenant: the catalogue is the same everywhere, and a tenant
 * cannot add to it.
 */
export async function syncPermissionCatalogue(db: Db): Promise<number> {
  for (const key of ALL_PERMISSIONS) {
    await db.permission.upsert({ where: { key }, update: {}, create: { key } });
  }
  return ALL_PERMISSIONS.length;
}

/**
 * Creates or updates this tenant's roles from the templates for its business type.
 *
 * Matching is by `(tenantId, key)` — never by name, which the tenant may have
 * customised. `name` and `description` are therefore written **only on create**:
 * re-running the seed must not undo a tenant's rename, and a seed that silently
 * reverted display names would be discovered by an operator, not by a test.
 * Permission assignments *are* re-applied, because those are the platform's
 * definition of the role rather than the tenant's presentation of it.
 *
 * ## Two refusals (D108)
 *
 * This runs against EXISTING tenants too — the production backfill
 * (`backfill-tenant-roles.ts`) is exactly that — so a row it finds under a
 * template key is not necessarily one it wrote:
 *
 * - A **tenant-created** row under a BUILT-IN template's key is refused, not
 *   adopted. Adopting it would mark it built-in and `set` its permissions to
 *   the template's — for SALESPERSON that is the owner's set — promoting
 *   everyone holding a narrow custom role to owner-equivalent on an
 *   idempotent re-run. The test is "a built-in's row must be a system row":
 *   the operational templates (Waiter, Kitchen staff, …) are seeded as
 *   NON-system rows by design, so `isSystem` cannot tell a seeded Waiter from
 *   a tenant-created one, and those keep being adopted as they always were —
 *   which is also what makes a restaurant's re-seed idempotent.
 *   (`RolesService.create` refuses every template key going forward; this
 *   guards rows created before it did, where the stakes are highest.)
 * - A row with the template's **display name** under a different key would
 *   make the create fail on `@@unique([tenantId, name])` half-way through the
 *   loop with a raw constraint error. Named here instead, before anything is
 *   written for that template, so the operator knows what to rename.
 *
 * Both throw: a seed that silently skipped a role would leave a tenant without
 * it and nothing red.
 */
export async function seedTenantRoles(
  db: Db,
  tenantId: string,
  businessType: string,
): Promise<RoleTemplate[]> {
  const templates = roleTemplatesForBusinessType(businessType);

  for (const template of templates) {
    const permissions = { connect: template.permissions.map((key) => ({ key })) };

    const existing = await db.role.findUnique({
      where: { tenantId_key: { tenantId, key: template.key } },
      select: { id: true, isSystem: true },
    });

    if (existing) {
      if (template.isBuiltIn && !existing.isSystem) {
        throw new Error(
          `Refusing to seed role ${template.key} for tenant ${tenantId}: a tenant-created role ` +
            `already uses that key. Built-in keys are reserved; rename or archive the custom role first.`,
        );
      }
      await db.role.update({
        where: { id: existing.id },
        // `set` rather than `connect`: a permission removed from a template must
        // disappear from the role, or a revocation would never take effect.
        data: { isSystem: template.isBuiltIn, permissions: { set: template.permissions.map((key) => ({ key })) } },
      });
    } else {
      const nameClash = await db.role.findUnique({
        where: { tenantId_name: { tenantId, name: template.name } },
        select: { key: true },
      });
      if (nameClash) {
        throw new Error(
          `Refusing to seed role ${template.key} for tenant ${tenantId}: a role named ` +
            `"${template.name}" already exists (key ${nameClash.key ?? 'none'}). Rename it first.`,
        );
      }
      await db.role.create({
        data: {
          tenantId,
          key: template.key,
          name: template.name,
          description: template.description,
          isSystem: template.isBuiltIn,
          permissions,
        },
      });
    }
  }

  return [...templates];
}

/**
 * Links each of a tenant's users to the role row matching their `UserRole`
 * (Phase 1.5.4).
 *
 * This is what moves a user from `LEGACY_FALLBACK` to `DATABASE` resolution. It is
 * safe precisely because parity is proven first: the role rows grant exactly what
 * `ROLE_PERMISSIONS` grants, so the switch changes the *source* of a user's
 * permissions and not the permissions themselves.
 *
 * Only ever links within the tenant, and only to a role whose key matches the
 * user's enum value. A user whose role has no matching row is left on the legacy
 * path rather than linked to something approximate — a wrong link is a silent
 * permission change, while no link is the status quo.
 */
export async function linkUsersToRoles(db: DbWithUsers, tenantId: string): Promise<number> {
  // Seeded, active rows only. A tenant-created row that happens to carry an
  // enum's key (possible before `RolesService` reserved those keys) is not the
  // built-in, and linking to it would hand the user that role's permissions —
  // "something approximate", which the contract above rules out. An archived
  // row fails closed at resolution, so a link to one would be a lockout
  // dressed up as a migration.
  const roles = await db.role.findMany({
    where: { tenantId, isActive: true, isSystem: true },
    select: { id: true, key: true },
  });
  const byKey = new Map(roles.filter((r) => r.key).map((r) => [r.key as string, r.id]));

  const users = await db.user.findMany({
    where: { tenantId, roleId: null },
    select: { id: true, role: true },
  });

  let linked = 0;
  for (const user of users) {
    const roleId = byKey.get(user.role);
    if (!roleId) continue;
    await db.user.update({ where: { id: user.id }, data: { roleId } });
    linked += 1;
  }
  return linked;
}
