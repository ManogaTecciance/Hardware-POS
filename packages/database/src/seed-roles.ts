/**
 * Clones the approved role templates into a tenant (Phase 1.5, D36/D37).
 *
 * Used by `prisma/seed.ts` and `prisma/provision-tenant.ts` so a tenant created by
 * either route ends up with the same roles. A tenant with no role rows must fail
 * closed once authorization reads them, so seeding is part of creating a tenant,
 * not an optional extra.
 *
 * ## What it does not do
 *
 * It does not assign a role to a user, and nothing reads these rows at
 * authorization time yet. This slice lands the authority **inert**: `User.role`
 * (the enum) is still what grants permissions, and stays so until parity is proven
 * and the resolution switch is made deliberately.
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
      select: { id: true },
    });

    if (existing) {
      await db.role.update({
        where: { id: existing.id },
        // `set` rather than `connect`: a permission removed from a template must
        // disappear from the role, or a revocation would never take effect.
        data: { isSystem: template.isBuiltIn, permissions: { set: template.permissions.map((key) => ({ key })) } },
      });
    } else {
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
  const roles = await db.role.findMany({
    where: { tenantId },
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
