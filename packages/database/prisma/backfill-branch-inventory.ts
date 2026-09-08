/**
 * Phase 2.5 backfill (D10, AD-16).
 *
 * Populate `BranchInventory` from `Product.quantityOnHand`, using each
 * tenant's default branch (the first active branch by createdAt). Also
 * writes one OPENING `StockMovement` per (branch, product) so the ledger
 * is well-formed from row zero.
 *
 * Non-destructive: `Product.quantityOnHand` is not touched. An existing
 * `BranchInventory` row is preserved unchanged (idempotent re-run).
 *
 * Run once per environment before flipping `INVENTORY_BRANCH_SCOPED`:
 *
 *   pnpm --filter @hardware-pos/database exec \
 *     tsx prisma/backfill-branch-inventory.ts
 */
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const tenants = await prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    });

    console.log(`Backfilling branch inventory for ${tenants.length} tenant(s).\n`);

    for (const tenant of tenants) {
      const branch = await prisma.branch.findFirst({
        where: { tenantId: tenant.id, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
      });
      if (!branch) {
        console.log(`  ${tenant.name}: no active branch — skipped.`);
        continue;
      }

      const products = await prisma.product.findMany({
        where: { tenantId: tenant.id, type: 'Inventory' },
        select: { id: true, quantityOnHand: true },
      });

      let created = 0;
      let existing = 0;
      for (const product of products) {
        const exists = await prisma.branchInventory.findUnique({
          where: { branchId_productId: { branchId: branch.id, productId: product.id } },
          select: { id: true },
        });
        if (exists) {
          existing += 1;
          continue;
        }
        await prisma.$transaction(async (tx) => {
          await tx.branchInventory.create({
            data: {
              tenantId: tenant.id,
              branchId: branch.id,
              productId: product.id,
              quantityOnHand: product.quantityOnHand,
            },
          });
          await tx.stockMovement.create({
            data: {
              tenantId: tenant.id,
              branchId: branch.id,
              productId: product.id,
              delta: product.quantityOnHand,
              balanceAfter: product.quantityOnHand,
              reason: 'OPENING',
              refType: 'BACKFILL',
              refId: `phase-2.5-backfill-${tenant.id}`,
            },
          });
        });
        created += 1;
      }

      console.log(
        `  ${tenant.name} → ${branch.name}: ${created} created, ${existing} already present.`,
      );
    }
    console.log('\nBackfill complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
