/**
 * D57 — classify a legacy no-profile tenant as HARDWARE, explicitly.
 *
 * The pilot tenant has run since launch with no `TenantBusinessProfile` row,
 * resolving through `LEGACY_TENANT_DEFAULTS` in code. The PO ruled it IS a
 * hardware-template business, so this writes the row that makes the
 * classification data.
 *
 * An OPERATIONAL script, deliberately not a migration: reclassifying a live
 * tenant is something an operator runs with eyes on the report, not something
 * `migrate deploy` does silently (convergence plan §12.1).
 *
 * ## The behaviour-preservation guard
 *
 * Writing the row moves the tenant from LEGACY_DEFAULT to EXPLICIT
 * resolution. That is only safe because HARDWARE's defaults are exactly the
 * legacy defaults — which this script PROVES per run rather than assumes: it
 * compares the module set and provider pair the tenant would resolve to
 * before and after, and refuses to write on any difference. The one permitted
 * change is the businessType value itself.
 *
 * Usage:
 *   npx tsx prisma/backfill-pilot-profile.ts <tenant-slug>            # dry run
 *   npx tsx prisma/backfill-pilot-profile.ts <tenant-slug> --write
 */
import { PrismaClient } from '@prisma/client';
import { domainFor } from '@hardware-pos/shared';

import { BUSINESS_PROFILE_PRESETS } from '../src/business-profile-presets';

/**
 * Mirror of `LEGACY_TENANT_DEFAULTS` (apps/api/src/modules/platform/
 * platform.constants.ts). Restated here because this package cannot import
 * the API; the equality assertion below is what keeps the copy honest — if
 * the API constant ever drifts from HARDWARE's descriptor, the same drift
 * breaks `platform.constants.spec.ts` first.
 */
const LEGACY_MODULES = [
  'RETAIL_POS',
  'INVENTORY',
  'CUSTOMERS',
  'QUOTATIONS',
  'RETURNS',
  'EXCHANGES',
  'SUPPLIERS',
  'REPORTING',
  'USERS',
  'BRANCHES',
  'SETTINGS',
  'BRANDING',
  'QUICKBOOKS',
] as const;

async function main() {
  const [slug, flag] = process.argv.slice(2);
  if (!slug) {
    console.error('Usage: npx tsx prisma/backfill-pilot-profile.ts <tenant-slug> [--write]');
    process.exit(2);
  }
  const write = flag === '--write';
  const prisma = new PrismaClient();
  try {
    const tenant = await prisma.tenant.findFirst({
      where: { slug },
      select: { id: true, name: true, businessProfile: true },
    });
    if (!tenant) throw new Error(`No tenant with slug "${slug}"`);
    if (tenant.businessProfile) {
      console.log(
        `Nothing to do: ${tenant.name} already has an explicit profile ` +
          `(${tenant.businessProfile.businessType}).`,
      );
      return;
    }

    // The guard: HARDWARE's declared defaults must equal the legacy defaults.
    const hardware = domainFor('HARDWARE');
    const preset = BUSINESS_PROFILE_PRESETS.HARDWARE;
    const declared = [...hardware.modules].sort().join(',');
    const legacy = [...LEGACY_MODULES].sort().join(',');
    if (declared !== legacy) {
      throw new Error(
        `REFUSED — HARDWARE's default modules differ from the legacy set.\n  legacy:   ${legacy}\n  declared: ${declared}\nWriting the row would change this tenant's effective modules.`,
      );
    }
    if (preset.inventoryMode !== 'QUICKBOOKS' || preset.accountingProvider !== 'QUICKBOOKS') {
      throw new Error(
        `REFUSED — HARDWARE's preset is ${preset.inventoryMode}/${preset.accountingProvider}, not the legacy QUICKBOOKS/QUICKBOOKS pair.`,
      );
    }

    console.log(`${write ? 'Writing' : 'DRY RUN —'} profile for ${tenant.name} (${tenant.id}):`);
    console.log(`  businessType       HARDWARE  (was: legacy default)`);
    console.log(`  inventoryMode      ${preset.inventoryMode}`);
    console.log(`  accountingProvider ${preset.accountingProvider}`);
    console.log(`  effective modules  unchanged (verified equal to the legacy 13)`);
    if (!write) {
      console.log('\nRe-run with --write to apply.');
      return;
    }
    await prisma.tenantBusinessProfile.create({
      data: { tenantId: tenant.id, businessType: 'HARDWARE', ...preset },
    });
    console.log('\n✔ Written. The tenant now resolves EXPLICIT instead of LEGACY_DEFAULT.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
