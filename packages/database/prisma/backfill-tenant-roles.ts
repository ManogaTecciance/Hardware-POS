/**
 * D108 — give an EXISTING tenant its role rows, and link its users to them.
 *
 * Every tenant created since Phase 1.5 gets its roles at provisioning
 * (`provision-tenant.ts`, the platform console). A tenant that predates that —
 * the production pilot — has a `Role` table with nothing in it: the two role
 * migrations were additive and wrote no data, and every one of its users still
 * resolves through the legacy enum fallback. Nothing in `migrate deploy` ever
 * changes that, by design (convergence plan §12.1): populating a live tenant's
 * authority is something an operator runs with eyes on the report.
 *
 * Per tenant, in one transaction:
 *   1. `syncPermissionCatalogue` — the global permission rows.
 *   2. `seedTenantRoles` for the tenant's business type — the pilot's explicit
 *      profile says HARDWARE (D57); a tenant with no profile row resolves to
 *      HARDWARE exactly as the API does. Idempotent, never deletes, and it
 *      refuses (rather than adopts or renames) a tenant-created role that
 *      sits under a template key or name — see `seed-roles.ts`.
 *   3. `linkUsersToRoles` — every user whose enum value has a row of that key
 *      is linked to it. A user on an enum with no template (MANAGER,
 *      ACCOUNTANT, ADMIN — retired 2026-08-17) is left on the fallback and
 *      LISTED, because moving them is a re-role decision for a person, not a
 *      script.
 *
 * Then confirm with `role-authority-report.ts`.
 *
 * Usage:
 *   npx tsx prisma/backfill-tenant-roles.ts <tenant-slug>            # dry run
 *   npx tsx prisma/backfill-tenant-roles.ts <tenant-slug> --write
 */
import { PrismaClient } from '@prisma/client';
import { roleTemplatesForBusinessType } from '@hardware-pos/shared';

import { linkUsersToRoles, seedTenantRoles, syncPermissionCatalogue } from '../src/seed-roles';

async function main() {
  const [slug, flag] = process.argv.slice(2);
  if (!slug) {
    console.error('Usage: npx tsx prisma/backfill-tenant-roles.ts <tenant-slug> [--write]');
    process.exit(2);
  }
  const write = flag === '--write';
  const prisma = new PrismaClient();
  try {
    const tenant = await prisma.tenant.findFirst({
      where: { slug },
      select: {
        id: true,
        name: true,
        businessProfile: { select: { businessType: true } },
        roles: { select: { key: true, name: true, isSystem: true, isActive: true } },
        users: { select: { id: true, email: true, role: true, roleId: true, isActive: true } },
      },
    });
    if (!tenant) throw new Error(`No tenant with slug "${slug}"`);

    // The same default the API and provision-tenant.ts apply to a no-profile
    // tenant (D57): it IS a hardware business, it just never said so in a row.
    const businessType = tenant.businessProfile?.businessType ?? 'HARDWARE';
    const templates = roleTemplatesForBusinessType(businessType);
    const templateKeys = new Set(templates.map((t) => t.key));
    const existingKeys = new Set(tenant.roles.map((r) => r.key));

    const toCreate = templates.filter((t) => !existingKeys.has(t.key)).map((t) => t.key);
    const toRefresh = templates.filter((t) => existingKeys.has(t.key)).map((t) => t.key);
    // Same rule as `linkUsersToRoles`: a user links to the SEEDED row whose key
    // is their enum value — which, after this run, is exactly the template set
    // (a tenant-created row under a template key is refused below, not linked).
    const unlinked = tenant.users.filter((u) => u.roleId === null);
    const willLink = unlinked.filter((u) => templateKeys.has(u.role));
    const stayOnFallback = unlinked.filter((u) => !templateKeys.has(u.role));

    console.log(
      `${write ? 'Writing' : 'DRY RUN —'} roles for ${tenant.name} (${tenant.id}), template ${businessType}` +
        (tenant.businessProfile ? '' : ' (no profile row: legacy default, D57)'),
    );
    console.log(`  create   ${toCreate.length ? toCreate.join(', ') : '(none)'}`);
    console.log(`  refresh  ${toRefresh.length ? toRefresh.join(', ') : '(none)'}  (permissions re-applied from the template)`);
    console.log(`  link     ${willLink.length} of ${tenant.users.length} users` + (willLink.length ? ':' : ''));
    for (const u of willLink) console.log(`             ${u.role.padEnd(12)} ${u.email ?? u.id}`);
    if (stayOnFallback.length) {
      console.log(`  fallback ${stayOnFallback.length} users have no template row for their enum role and stay on the legacy fallback:`);
      for (const u of stayOnFallback) {
        console.log(`             ${u.role.padEnd(12)} ${u.email ?? u.id}${u.isActive ? '' : '  (inactive)'}  ← re-role by hand`);
      }
    }

    // Name the collisions before writing anything, so the operator gets the
    // whole list and not the first constraint error.
    // Mirrors `seedTenantRoles`' two refusals: a tenant-created row under a
    // BUILT-IN template's key (operational templates are non-system rows by
    // design, so those are adopted), and a display-name collision.
    const builtInKeys = new Set(templates.filter((t) => t.isBuiltIn).map((t) => t.key));
    const clashes = tenant.roles.filter(
      (r) =>
        (r.key !== null && builtInKeys.has(r.key) && !r.isSystem) ||
        templates.some((t) => t.name === r.name && t.key !== r.key),
    );
    if (clashes.length) {
      console.log('\nREFUSED — tenant-created roles collide with the template:');
      for (const r of clashes) console.log(`  ${r.key ?? '(no key)'}  "${r.name}"  system=${r.isSystem} active=${r.isActive}`);
      console.log('Rename or archive them, then re-run.');
      process.exit(1);
    }

    if (!write) {
      console.log('\nRe-run with --write to apply.');
      return;
    }
    // The catalogue sync is sixty-odd sequential upserts; over a production
    // link that can outrun Prisma's default five-second interactive
    // transaction, which would roll everything back with a timeout the
    // operator cannot act on.
    const result = await prisma.$transaction(
      async (tx) => {
        const permissions = await syncPermissionCatalogue(tx);
        const roles = await seedTenantRoles(tx, tenant.id, businessType);
        const linked = await linkUsersToRoles(tx, tenant.id);
        return { permissions, roles: roles.length, linked };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    console.log(
      `\n✔ Written. ${result.permissions} permissions in the catalogue, ${result.roles} roles seeded, ` +
        `${result.linked} users linked. Confirm with prisma/role-authority-report.ts.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
