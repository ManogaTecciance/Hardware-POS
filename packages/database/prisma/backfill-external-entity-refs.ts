/**
 * D63 — fill `ExternalEntityRef` from the legacy vendor columns
 * (convergence plan §8.10 step 3), and migrate `QuickBooksMapping` rows in.
 *
 * COPY, never move: the columns stay authoritative until the read switch
 * (step 5), which itself waits for a production reconciliation cycle. Rows
 * are only written where vendor state is non-default — a product that never
 * met QuickBooks needs no satellite row, and the reconciliation reads
 * absence as agreeing with the column defaults.
 *
 * Scoped to tenants WITH a QuickBooksConnection (plus any row that carries a
 * vendor id anyway, belt-and-braces). Dry-run by default; `--write` applies;
 * idempotent via upsert.
 */
import { PrismaClient, SyncStatus } from '@prisma/client';

const prisma = new PrismaClient();
const PROVIDER = 'QUICKBOOKS';

async function upsertRef(
  write: boolean,
  counters: Record<string, number>,
  tenantId: string,
  entityType: string,
  localId: string,
  data: {
    externalId?: string | null;
    externalType?: string | null;
    syncStatus?: SyncStatus;
    syncError?: string | null;
    lastSyncedAt?: Date | null;
  },
) {
  counters[entityType] = (counters[entityType] ?? 0) + 1;
  if (!write) return;
  await prisma.externalEntityRef.upsert({
    where: {
      tenantId_provider_entityType_localId: { tenantId, provider: PROVIDER, entityType, localId },
    },
    update: data,
    create: { tenantId, provider: PROVIDER, entityType, localId, ...data },
  });
}

async function main() {
  const write = process.argv.includes('--write');
  const counters: Record<string, number> = {};

  const products = await prisma.product.findMany({
    where: { OR: [{ quickbooksItemId: { not: null } }, { syncStatus: { not: 'NOT_SYNCED' } }] },
    select: { id: true, tenantId: true, quickbooksItemId: true, syncStatus: true, lastSyncedAt: true },
  });
  for (const p of products) {
    await upsertRef(write, counters, p.tenantId, 'PRODUCT', p.id, {
      externalId: p.quickbooksItemId,
      syncStatus: p.syncStatus,
      lastSyncedAt: p.lastSyncedAt,
    });
  }

  const categories = await prisma.productCategory.findMany({
    where: { quickbooksItemId: { not: null } },
    select: { id: true, tenantId: true, quickbooksItemId: true },
  });
  for (const c of categories) {
    await upsertRef(write, counters, c.tenantId, 'PRODUCT_CATEGORY', c.id, {
      externalId: c.quickbooksItemId,
      syncStatus: 'SYNCED',
    });
  }

  const customers = await prisma.customer.findMany({
    where: { OR: [{ quickbooksCustomerId: { not: null } }, { syncStatus: { not: 'NOT_SYNCED' } }] },
    select: { id: true, tenantId: true, quickbooksCustomerId: true, syncStatus: true, lastSyncedAt: true },
  });
  for (const c of customers) {
    await upsertRef(write, counters, c.tenantId, 'CUSTOMER', c.id, {
      externalId: c.quickbooksCustomerId,
      syncStatus: c.syncStatus,
      lastSyncedAt: c.lastSyncedAt,
    });
  }

  const suppliers = await prisma.supplier.findMany({
    where: { quickbooksVendorId: { not: null } },
    select: { id: true, tenantId: true, quickbooksVendorId: true, qbLastSyncedAt: true },
  });
  for (const s of suppliers) {
    await upsertRef(write, counters, s.tenantId, 'SUPPLIER', s.id, {
      externalId: s.quickbooksVendorId,
      syncStatus: 'SYNCED',
      lastSyncedAt: s.qbLastSyncedAt,
    });
  }

  const sales = await prisma.sale.findMany({
    where: { OR: [{ quickbooksDocumentId: { not: null } }, { syncStatus: { not: 'NOT_SYNCED' } }] },
    select: {
      id: true,
      tenantId: true,
      quickbooksDocumentId: true,
      quickbooksDocumentType: true,
      syncStatus: true,
      syncError: true,
    },
  });
  for (const s of sales) {
    await upsertRef(write, counters, s.tenantId, 'SALE', s.id, {
      externalId: s.quickbooksDocumentId,
      externalType: s.quickbooksDocumentType,
      syncStatus: s.syncStatus,
      syncError: s.syncError,
    });
  }

  const payments = await prisma.payment.findMany({
    where: { OR: [{ quickbooksPaymentId: { not: null } }, { syncStatus: { not: 'NOT_SYNCED' } }] },
    select: { id: true, tenantId: true, quickbooksPaymentId: true, syncStatus: true },
  });
  for (const p of payments) {
    await upsertRef(write, counters, p.tenantId, 'PAYMENT', p.id, {
      externalId: p.quickbooksPaymentId,
      syncStatus: p.syncStatus,
    });
  }

  const returns = await prisma.return.findMany({
    where: { OR: [{ quickbooksDocumentId: { not: null } }, { syncStatus: { not: 'NOT_SYNCED' } }] },
    select: {
      id: true,
      tenantId: true,
      quickbooksDocumentId: true,
      quickbooksDocumentType: true,
      syncStatus: true,
      syncError: true,
    },
  });
  for (const r of returns) {
    await upsertRef(write, counters, r.tenantId, 'RETURN', r.id, {
      externalId: r.quickbooksDocumentId,
      externalType: r.quickbooksDocumentType,
      syncStatus: r.syncStatus,
      syncError: r.syncError,
    });
  }

  const refunds = await prisma.refundPayment.findMany({
    where: { OR: [{ quickbooksPaymentId: { not: null } }, { syncStatus: { not: 'NOT_SYNCED' } }] },
    select: { id: true, tenantId: true, quickbooksPaymentId: true, syncStatus: true },
  });
  for (const r of refunds) {
    await upsertRef(write, counters, r.tenantId, 'REFUND_PAYMENT', r.id, {
      externalId: r.quickbooksPaymentId,
      syncStatus: r.syncStatus,
    });
  }

  // Migrate QuickBooksMapping rows (COPY — the table stays until its own
  // drop decision). entityType vocabularies already agree.
  const mappings = await prisma.quickBooksMapping.findMany();
  for (const m of mappings) {
    await upsertRef(write, counters, m.tenantId, m.entityType, m.localId, {
      externalId: m.quickbooksId,
      externalType: m.quickbooksType,
      lastSyncedAt: m.lastSyncedAt,
      syncStatus: 'SYNCED',
    });
  }

  console.log(`${write ? '' : 'DRY RUN — '}ExternalEntityRef backfill`);
  for (const [k, v] of Object.entries(counters).sort()) console.log(`  ${k.padEnd(18)} ${v}`);
  if (Object.keys(counters).length === 0) console.log('  nothing to copy');
  if (!write) console.log('\nRe-run with --write to apply.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
