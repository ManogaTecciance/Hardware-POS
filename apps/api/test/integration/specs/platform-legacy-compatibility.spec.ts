/**
 * Slice 4 changed nothing about how a Tile Shop tenant transacts.
 *
 * The Slice 3 characterisation suites are the primary evidence: they run unedited
 * against this schema and stay green. This spec adds what they cannot express —
 * that the *same* behaviour holds now that the platform tables exist, and that it
 * is identical whether the tenant has no profile row at all or an explicit row
 * stating the legacy values.
 *
 * That parity is the real compatibility claim. "No row" is what production has
 * today; "an explicit legacy row" is what a tenant gets the first time an
 * administrator saves anything in the new UI. If those two diverged, saving the
 * settings screen would silently change how sales post to QuickBooks.
 */

import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  ModuleKey,
  type PrismaClient,
} from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { dto } from '../dto';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createIntegrationApp, type IntegrationApp } from '../test-app';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';
import { CreateReturnDto } from '../../../src/modules/returns/dto/create-return.dto';
import { LEGACY_TENANT_DEFAULTS } from '../../../src/modules/platform/platform.constants';
// Referencing the production constants rather than repeating string literals: an
// assertion that hardcodes 'RETURNS_SYNC' tests the spelling in the spec, not the
// behaviour of the queue.
import { SyncJobType } from '../../../src/modules/sync/queue/sync-queue.constants';

let prisma: PrismaClient;
let app: IntegrationApp;
let tenant: SeededTenant;
let owner: AuthenticatedUser;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  app = await createIntegrationApp();
});

afterAll(async () => {
  await app.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tenant = await seedTileShopWithQuickBooks(prisma);
  owner = { id: tenant.ownerId, tenantId: tenant.tenantId, role: 'OWNER' };
});

/** Write the legacy configuration as an EXPLICIT row, to test parity with "no row". */
async function writeExplicitLegacyProfile(): Promise<void> {
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: tenant.tenantId,
      businessType: LEGACY_TENANT_DEFAULTS.businessType,
      inventoryMode: LEGACY_TENANT_DEFAULTS.inventoryMode,
      accountingProvider: LEGACY_TENANT_DEFAULTS.accountingProvider,
    },
  });
}

/** No profile row, then an explicit legacy row — the same assertions must hold for both. */
const BOTH_SHAPES: [string, () => Promise<void>][] = [
  ['no profile row (production today)', async () => {}],
  ['an explicit legacy profile row', writeExplicitLegacyProfile],
];

function oneUnitOfA() {
  return [{ productId: tenant.productAId, quantity: 1 }];
}

async function onHand(productId: string): Promise<number> {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  return Number(product.quantityOnHand);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 — legacy paid sale
// ─────────────────────────────────────────────────────────────────────────────

describe.each(BOTH_SHAPES)('with %s', (_label, setUpProfile) => {
  beforeEach(async () => {
    await setUpProfile();
  });

  it('a fully paid sale still completes as PAID and maps to a SALES_RECEIPT', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      registerId: tenant.registerId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 1000 }],
    });

    expect(sale.status).toBe('COMPLETED');
    expect(sale.paymentStatus).toBe('PAID');
    expect(sale.quickbooksDocumentType).toBe('SALES_RECEIPT');
    expect(Number(sale.total)).toBe(1000);
    expect(Number(sale.balanceAmount)).toBe(0);
  });

  it('a paid sale still decrements local stock inside the sale transaction', async () => {
    await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 1000 }],
    });

    // Product.quantityOnHand is preserved and still authoritative (decision D10).
    expect(await onHand(tenant.productAId)).toBe(99);
  });

  it('a paid sale still enqueues exactly one QuickBooks SyncJob', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 1000 }],
    });

    const jobs = await prisma.syncJob.findMany({ where: { entityId: sale.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe(SyncJobType.SALES_SYNC);
    expect(jobs[0].status).toBe('PENDING');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3 — legacy credit sale
  // ───────────────────────────────────────────────────────────────────────────

  it('a credit sale still maps to an INVOICE and stays UNPAID', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      customerId: tenant.creditCustomerId,
      items: oneUnitOfA(),
      payments: [],
    });

    expect(sale.paymentStatus).toBe('UNPAID');
    expect(sale.quickbooksDocumentType).toBe('INVOICE');
    expect(Number(sale.balanceAmount)).toBe(1000);
  });

  it('a partially paid sale still maps to an INVOICE', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      customerId: tenant.creditCustomerId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 400 }],
    });

    expect(sale.paymentStatus).toBe('PARTIAL');
    expect(sale.quickbooksDocumentType).toBe('INVOICE');
    expect(Number(sale.balanceAmount)).toBe(600);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4 — legacy return
  // ───────────────────────────────────────────────────────────────────────────

  it('a return still restocks and enqueues a return sync', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: [{ productId: tenant.productAId, quantity: 2 }],
      payments: [{ method: 'CASH', amount: 2000 }],
    });
    const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });
    expect(await onHand(tenant.productAId)).toBe(98);
    // Only the return's own job should be left to assert on.
    await prisma.syncJob.deleteMany({ where: { tenantId: tenant.tenantId } });

    // A partial return (1 of 2) of GOOD stock, refunded the way the sale was paid,
    // needs no manager approval — the rule set is pinned in the Slice 3 return
    // characterisation spec.
    const completed = await app.returnsService.complete(
      tenant.tenantId,
      owner,
      dto(CreateReturnDto, {
        originalSaleId: sale.id,
        refundMethod: 'CASH',
        items: [
          {
            saleItemId: saleItem.id,
            returnQuantity: 1,
            returnReason: 'CHANGED_MIND',
            itemCondition: 'GOOD',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
      }),
      null,
    );

    expect(completed.status).toBe('COMPLETED');
    expect(completed.refundStatus).toBe('COMPLETED');
    expect(Number(completed.refundTotal)).toBe(1000);
    expect(await onHand(tenant.productAId)).toBe(99);

    const jobs = await prisma.syncJob.findMany({ where: { entityId: completed.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe(SyncJobType.RETURN_SYNC);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5 — legacy QuickBooks product push
  // ───────────────────────────────────────────────────────────────────────────

  it('a product push is still enqueued for a QuickBooks-connected tenant', async () => {
    const queued = await app.syncQueueService.enqueueProductSync(
      tenant.tenantId,
      tenant.productAId,
    );

    expect(queued).toBe(true);
    const jobs = await prisma.syncJob.findMany({
      where: { tenantId: tenant.tenantId, entityId: tenant.productAId },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe(SyncJobType.PRODUCT_SYNC);
    expect(jobs[0].entityType).toBe('PRODUCT');
    expect(jobs[0].direction).toBe('OUTBOUND');

    const logs = await prisma.syncLog.findMany({
      where: { tenantId: tenant.tenantId, entityId: tenant.productAId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('Product queued for QuickBooks sync');
  });

  it('the resolved profile reports QuickBooks as the inventory and accounting master', async () => {
    const profile = await app.businessProfileService.getEffectiveProfile(tenant.tenantId);

    expect(profile.inventoryMode).toBe(InventoryMode.QUICKBOOKS);
    expect(profile.accountingProvider).toBe(AccountingProviderKind.QUICKBOOKS);
    expect(profile.businessType).toBe(BusinessType.TILE_SHOP);
    expect(profile.enabledModules).toContain(ModuleKey.QUICKBOOKS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The profile is inert in Slice 4
// ─────────────────────────────────────────────────────────────────────────────

describe('the profile does not yet influence transaction behaviour', () => {
  /**
   * Deliberate and worth stating plainly: Slice 4 adds configuration, not
   * behaviour. `inventoryMode` and `accountingProvider` are read by nothing in the
   * sale path yet — the provider ports that consume them arrive in Slice 5 and are
   * adopted in Slice 6.
   *
   * Pinning it means the day someone wires a provider in, this test fails and
   * forces the change to be deliberate rather than incidental.
   */
  it('a LOCAL/NONE profile still produces todays QuickBooks-shaped sale', async () => {
    await prisma.tenantBusinessProfile.create({
      data: {
        tenantId: tenant.tenantId,
        businessType: BusinessType.RESTAURANT,
        inventoryMode: InventoryMode.LOCAL,
        accountingProvider: AccountingProviderKind.NONE,
      },
    });

    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 1000 }],
    });

    expect(sale.quickbooksDocumentType).toBe('SALES_RECEIPT');
    expect(await prisma.syncJob.count({ where: { entityId: sale.id } })).toBe(1);
    expect(await onHand(tenant.productAId)).toBe(99);
  });

  it('changing the profile never rewrites existing sales', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 1000 }],
    });
    const before = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });

    await prisma.tenantBusinessProfile.create({
      data: {
        tenantId: tenant.tenantId,
        businessType: BusinessType.CAFE,
        inventoryMode: InventoryMode.LOCAL,
        accountingProvider: AccountingProviderKind.NONE,
      },
    });

    expect(await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } })).toEqual(before);
  });
});
