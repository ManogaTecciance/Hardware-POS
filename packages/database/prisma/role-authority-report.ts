/**
 * Role-authority migration readiness report (Phase 1.5.4).
 *
 * Answers one question: **can `User.role` be retired yet?** It reports the state
 * of the migration rather than asserting it is finished, because the answer for a
 * real deployment is "not until every user has a valid, tenant-owned role link and
 * built-in parity is exact".
 *
 * Read-only. It writes nothing and is safe to run against any database the caller
 * can already read.
 *
 *   pnpm --filter @hardware-pos/database exec tsx prisma/role-authority-report.ts
 */
import { PrismaClient } from '@prisma/client';
import { ROLE_PERMISSIONS, type UserRole } from '@hardware-pos/shared';

const prisma = new PrismaClient();

interface Report {
  totalUsers: number;
  usersWithRoleId: number;
  usersOnLegacyFallback: number;
  /** `roleId` set but the row does not exist — these users are DENIED, not degraded. */
  invalidRoleLinks: { userId: string; roleId: string }[];
  /** `roleId` resolves to a role owned by a different tenant. A breach if it ever appears. */
  crossTenantRoleLinks: { userId: string; userTenantId: string; roleTenantId: string }[];
  /** Built-in roles whose stored permissions differ from the code authority. */
  builtInParityDifferences: {
    tenantId: string;
    key: string;
    missing: string[];
    unexpected: string[];
  }[];
  /** Tenants with no role rows at all — every user there falls back. */
  tenantsWithoutRoles: string[];
}

export async function buildReport(db: PrismaClient = prisma): Promise<Report> {
  const users = await db.user.findMany({
    select: { id: true, tenantId: true, roleId: true, role: true },
  });
  const roles = await db.role.findMany({
    select: {
      id: true,
      key: true,
      tenantId: true,
      permissions: { select: { key: true } },
    },
  });
  const tenants = await db.tenant.findMany({ select: { id: true } });

  const roleById = new Map(roles.map((r) => [r.id, r]));
  const tenantsWithRoles = new Set(roles.map((r) => r.tenantId));

  const invalidRoleLinks: Report['invalidRoleLinks'] = [];
  const crossTenantRoleLinks: Report['crossTenantRoleLinks'] = [];

  for (const user of users) {
    if (!user.roleId) continue;
    const role = roleById.get(user.roleId);
    if (!role) {
      invalidRoleLinks.push({ userId: user.id, roleId: user.roleId });
      continue;
    }
    if (role.tenantId !== user.tenantId) {
      crossTenantRoleLinks.push({
        userId: user.id,
        userTenantId: user.tenantId,
        roleTenantId: role.tenantId,
      });
    }
  }

  const builtInParityDifferences: Report['builtInParityDifferences'] = [];
  for (const role of roles) {
    const key = role.key as UserRole | null;
    if (!key || !(key in ROLE_PERMISSIONS)) continue;

    const expected = new Set<string>(ROLE_PERMISSIONS[key]);
    const actual = new Set(role.permissions.map((p) => p.key));
    const missing = [...expected].filter((p) => !actual.has(p));
    const unexpected = [...actual].filter((p) => !expected.has(p));
    if (missing.length > 0 || unexpected.length > 0) {
      builtInParityDifferences.push({ tenantId: role.tenantId, key, missing, unexpected });
    }
  }

  return {
    totalUsers: users.length,
    usersWithRoleId: users.filter((u) => u.roleId).length,
    usersOnLegacyFallback: users.filter((u) => !u.roleId).length,
    invalidRoleLinks,
    crossTenantRoleLinks,
    builtInParityDifferences,
    tenantsWithoutRoles: tenants.map((t) => t.id).filter((id) => !tenantsWithRoles.has(id)),
  };
}

/** True when `User.role` could be retired without changing anyone's access. */
export function isReadyToRetireLegacyRole(report: Report): boolean {
  return (
    report.totalUsers > 0 &&
    report.usersOnLegacyFallback === 0 &&
    report.invalidRoleLinks.length === 0 &&
    report.crossTenantRoleLinks.length === 0 &&
    report.builtInParityDifferences.length === 0 &&
    report.tenantsWithoutRoles.length === 0
  );
}

async function main(): Promise<void> {
  const report = await buildReport();

  /* eslint-disable no-console */
  console.log('\nRole authority — migration readiness\n');
  console.log(`  Total users                  ${report.totalUsers}`);
  console.log(`  With a role link             ${report.usersWithRoleId}`);
  console.log(`  On legacy fallback           ${report.usersOnLegacyFallback}`);
  console.log(`  Invalid role links           ${report.invalidRoleLinks.length}`);
  console.log(`  Cross-tenant role links      ${report.crossTenantRoleLinks.length}`);
  console.log(`  Built-in parity differences  ${report.builtInParityDifferences.length}`);
  console.log(`  Tenants without roles        ${report.tenantsWithoutRoles.length}`);

  for (const link of report.invalidRoleLinks) {
    console.log(`\n  ✖ user ${link.userId} → role ${link.roleId} (does not exist) — DENIED`);
  }
  for (const link of report.crossTenantRoleLinks) {
    console.log(
      `\n  ✖ SECURITY: user ${link.userId} (${link.userTenantId}) → role in ${link.roleTenantId}`,
    );
  }
  for (const diff of report.builtInParityDifferences) {
    console.log(`\n  ✖ ${diff.tenantId}/${diff.key}`);
    if (diff.missing.length) console.log(`      missing:    ${diff.missing.join(', ')}`);
    if (diff.unexpected.length) console.log(`      unexpected: ${diff.unexpected.join(', ')}`);
  }

  console.log(
    isReadyToRetireLegacyRole(report)
      ? '\n  ✔ Every user resolves from the database. `User.role` could be retired.\n'
      : '\n  ⏳ Not ready — `User.role` must stay until the counts above are clean.\n',
  );
  /* eslint-enable no-console */
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
