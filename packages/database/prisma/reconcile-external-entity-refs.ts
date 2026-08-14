/**
 * D63 — READ-ONLY reconciliation between the legacy vendor columns and
 * `ExternalEntityRef` (convergence plan §8.10 step 4).
 *
 * The gate before the read switch (step 5): run this against production for
 * a full sync cycle; the switch deploys only when it reports zero
 * mismatches. A missing satellite row AGREES with default column state
 * (NOT_SYNCED, no external id) — the backfill deliberately writes no row for
 * entities that never met QuickBooks.
 *
 * Exit code 0 = satellite complete; 1 = mismatches listed.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const PROVIDER = 'QUICKBOOKS';

interface Mismatch {
  entityType: string;
  localId: string;
  field: string;
  column: string | null;
  satellite: string | null;
}

async function main() {
  const mismatches: Mismatch[] = [];
  const refs = new Map<string, { externalId: string | null; syncStatus: string }>();
  for (const r of await prisma.externalEntityRef.findMany({ where: { provider: PROVIDER } })) {
    refs.set(`${r.entityType}:${r.localId}`, { externalId: r.externalId, syncStatus: r.syncStatus });
  }

  const check = (
    entityType: string,
    localId: string,
    columnId: string | null,
    columnStatus: string,
  ) => {
    const ref = refs.get(`${entityType}:${localId}`);
    if (!ref) {
      // Absence agrees only with default state.
      if (columnId !== null) {
        mismatches.push({ entityType, localId, field: 'externalId', column: columnId, satellite: null });
      }
      if (columnStatus !== 'NOT_SYNCED') {
        mismatches.push({ entityType, localId, field: 'syncStatus', column: columnStatus, satellite: null });
      }
      return;
    }
    if ((ref.externalId ?? null) !== (columnId ?? null)) {
      mismatches.push({ entityType, localId, field: 'externalId', column: columnId, satellite: ref.externalId });
    }
    if (ref.syncStatus !== columnStatus) {
      mismatches.push({ entityType, localId, field: 'syncStatus', column: columnStatus, satellite: ref.syncStatus });
    }
  };

  for (const p of await prisma.product.findMany({
    select: { id: true, quickbooksItemId: true, syncStatus: true },
  })) {
    check('PRODUCT', p.id, p.quickbooksItemId, p.syncStatus);
  }
  for (const c of await prisma.customer.findMany({
    select: { id: true, quickbooksCustomerId: true, syncStatus: true },
  })) {
    check('CUSTOMER', c.id, c.quickbooksCustomerId, c.syncStatus);
  }
  for (const s of await prisma.sale.findMany({
    select: { id: true, quickbooksDocumentId: true, syncStatus: true },
  })) {
    check('SALE', s.id, s.quickbooksDocumentId, s.syncStatus);
  }
  for (const p of await prisma.payment.findMany({
    select: { id: true, quickbooksPaymentId: true, syncStatus: true },
  })) {
    check('PAYMENT', p.id, p.quickbooksPaymentId, p.syncStatus);
  }
  for (const r of await prisma.return.findMany({
    select: { id: true, quickbooksDocumentId: true, syncStatus: true },
  })) {
    check('RETURN', r.id, r.quickbooksDocumentId, r.syncStatus);
  }
  for (const r of await prisma.refundPayment.findMany({
    select: { id: true, quickbooksPaymentId: true, syncStatus: true },
  })) {
    check('REFUND_PAYMENT', r.id, r.quickbooksPaymentId, r.syncStatus);
  }
  for (const c of await prisma.productCategory.findMany({
    select: { id: true, quickbooksItemId: true },
  })) {
    check('PRODUCT_CATEGORY', c.id, c.quickbooksItemId, c.quickbooksItemId ? 'SYNCED' : 'NOT_SYNCED');
  }
  for (const s of await prisma.supplier.findMany({
    select: { id: true, quickbooksVendorId: true },
  })) {
    check('SUPPLIER', s.id, s.quickbooksVendorId, s.quickbooksVendorId ? 'SYNCED' : 'NOT_SYNCED');
  }

  console.log(`ExternalEntityRef reconciliation: ${mismatches.length} mismatch(es)`);
  for (const m of mismatches.slice(0, 50)) {
    console.log(
      `  ${m.entityType} ${m.localId} ${m.field}: column=${m.column ?? '∅'} satellite=${m.satellite ?? '∅'}`,
    );
  }
  if (mismatches.length > 50) console.log(`  … and ${mismatches.length - 50} more`);
  process.exitCode = mismatches.length === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  })
  .finally(() => prisma.$disconnect());
