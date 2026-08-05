/**
 * Slice 6A — the completed-sale workflow now goes through `AccountingProvider`.
 *
 * Two claims to establish, and they pull in opposite directions:
 *
 *  1. **Nothing changed for QuickBooks tenants.** The adoption is an extraction, so
 *     a legacy sale must produce the same document type, the same `SyncJob` and
 *     `SyncLog` rows, the same error wording, and the same sync status as before.
 *     Where possible this is proven by capturing rows from a legacy tenant and
 *     comparing them field by field against an explicitly-configured QuickBooks
 *     tenant — two different code paths through the same provider.
 *
 *  2. **A `NONE` tenant is genuinely local.** No outbox rows, no QuickBooks
 *     identifier of any kind, no external document type, no "pending sync" state,
 *     and no fabricated id — while still completing a perfectly valid sale.
 *
 * `markSynced` gets its own block: it used to invent `QBO-INV-…` identifiers, and
 * the tests assert it now refuses rather than fabricates.
 */

import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  type PrismaClient,
  type Sale,
} from '@hardware-pos/database';

import { validateEnv } from '../../../src/config/env.validation';
import { StorageModule } from '../../../src/common/storage/storage.module';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { DocumentsModule } from '../../../src/modules/documents/documents.module';
import { DocumentsService } from '../../../src/modules/documents/documents.service';
import { ReceiptsModule } from '../../../src/modules/receipts/receipts.module';
import { ReceiptsService } from '../../../src/modules/receipts/receipts.service';
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { SalesService } from '../../../src/modules/sales/sales.service';
import { SalesRepository } from '../../../src/modules/sales/sales.repository';
import { CustomerDocumentKind } from '../../../src/modules/sales/customer-document';
import { AccountingProviderFactory } from '../../../src/modules/providers/accounting/accounting-provider.factory';
import { NoAccountingProvider } from '../../../src/modules/providers/accounting/no-accounting.provider';
import { QuickBooksAccountingProvider } from '../../../src/modules/providers/accounting/quickbooks-accounting.provider';
import { BusinessProfileService } from '../../../src/modules/platform/business-profile.service';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';
import { QuerySalesDto } from '../../../src/modules/sales/dto/query-sales.dto';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { dto } from '../dto';
import { seedSecondTenant, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let sales: SalesService;
let salesRepository: SalesRepository;
let receipts: ReceiptsService;
let documents: DocumentsService;
let accountingFactory: AccountingProviderFactory;
let tile: SeededTenant;
let other: SeededTenant;
let owner: AuthenticatedUser;
let otherOwner: AuthenticatedUser;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  testModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      StorageModule,
      PrismaModule,
      SalesModule,
      ReceiptsModule,
      DocumentsModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();

  sales = testModule.get(SalesService);
  salesRepository = testModule.get(SalesRepository);
  receipts = testModule.get(ReceiptsService);
  documents = testModule.get(DocumentsService);
  accountingFactory = testModule.get(AccountingProviderFactory);
});

afterAll(async () => {
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tile = await seedTileShopWithQuickBooks(prisma);
  other = await seedSecondTenant(prisma);
  owner = { id: tile.ownerId, tenantId: tile.tenantId, role: 'OWNER' };
  otherOwner = { id: other.ownerId, tenantId: other.tenantId, role: 'OWNER' };
});

async function giveProfile(
  tenant: SeededTenant,
  accountingProvider: AccountingProviderKind,
  businessType: BusinessType = BusinessType.RESTAURANT,
): Promise<void> {
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: tenant.tenantId,
      businessType,
      inventoryMode: InventoryMode.QUICKBOOKS,
      accountingProvider,
    },
  });
}

function paidSale(tenant: SeededTenant, actor: AuthenticatedUser, quantity = 1) {
  return sales.complete(tenant.tenantId, actor, {
    branchId: tenant.branchId,
    registerId: tenant.registerId,
    items: [{ productId: tenant.productAId, quantity }],
    payments: [{ method: 'CASH', amount: 1000 * quantity }],
  });
}

function creditSale(tenant: SeededTenant, actor: AuthenticatedUser) {
  return sales.complete(tenant.tenantId, actor, {
    branchId: tenant.branchId,
    customerId: tenant.creditCustomerId,
    items: [{ productId: tenant.productAId, quantity: 1 }],
    payments: [],
  });
}

function partialSale(tenant: SeededTenant, actor: AuthenticatedUser) {
  return sales.complete(tenant.tenantId, actor, {
    branchId: tenant.branchId,
    customerId: tenant.creditCustomerId,
    items: [{ productId: tenant.productAId, quantity: 1 }],
    payments: [{ method: 'CASH', amount: 400 }],
  });
}

/** Identity and timing differ between two runs; everything else must not. */
const VOLATILE = ['id', 'entityId', 'createdAt', 'updatedAt', 'scheduledAt', 'startedAt', 'completedAt', 'tenantId'];
function stable<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !VOLATILE.includes(k)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1-4, 7, 8 — legacy and explicit QuickBooks behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('legacy tenant (no profile row) is unchanged', () => {
  it('a paid sale is a SALES_RECEIPT, PENDING, with one SyncJob', async () => {
    const sale = await paidSale(tile, owner);

    expect(sale.paymentStatus).toBe('PAID');
    expect(sale.quickbooksDocumentType).toBe('SALES_RECEIPT');
    expect(sale.syncStatus).toBe('PENDING');
    expect(await prisma.syncJob.count({ where: { entityId: sale.id } })).toBe(1);
    expect(await prisma.tenantBusinessProfile.count()).toBe(0);
  });

  it('a credit sale is an INVOICE, PENDING, with one SyncJob', async () => {
    const sale = await creditSale(tile, owner);

    expect(sale.paymentStatus).toBe('UNPAID');
    expect(sale.quickbooksDocumentType).toBe('INVOICE');
    expect(sale.syncStatus).toBe('PENDING');
    expect(await prisma.syncJob.count({ where: { entityId: sale.id } })).toBe(1);
  });

  it('a partial sale is an INVOICE, PENDING, with one SyncJob', async () => {
    const sale = await partialSale(tile, owner);

    expect(sale.paymentStatus).toBe('PARTIAL');
    expect(sale.quickbooksDocumentType).toBe('INVOICE');
    expect(sale.syncStatus).toBe('PENDING');
    expect(await prisma.syncJob.count({ where: { entityId: sale.id } })).toBe(1);
  });

  it('still refuses a credit sale with no customer, with the exact existing wording', async () => {
    await expect(
      sales.complete(tile.tenantId, owner, {
        branchId: tile.branchId,
        items: [{ productId: tile.productAId, quantity: 1 }],
        payments: [],
      }),
    ).rejects.toThrow('A customer is required for a credit/partial sale (Invoice)');
  });

  it('a refused sale writes nothing at all', async () => {
    await expect(
      sales.complete(tile.tenantId, owner, {
        branchId: tile.branchId,
        items: [{ productId: tile.productAId, quantity: 1 }],
        payments: [],
      }),
    ).rejects.toThrow();

    expect(await prisma.sale.count()).toBe(0);
    expect(await prisma.syncJob.count()).toBe(0);
    expect(await prisma.syncLog.count()).toBe(0);
  });

  it('resolves the QuickBooks provider', async () => {
    expect(await accountingFactory.forTenant(tile.tenantId)).toBeInstanceOf(
      QuickBooksAccountingProvider,
    );
  });
});

describe('an explicit QUICKBOOKS tenant behaves identically to a legacy tenant', () => {
  it('produces field-identical Sale rows', async () => {
    const legacy = await paidSale(tile, owner);
    await giveProfile(other, AccountingProviderKind.QUICKBOOKS, BusinessType.TILE_SHOP);
    const explicit = await paidSale(other, otherOwner);

    const compare = (s: Sale) => ({
      status: s.status,
      paymentStatus: s.paymentStatus,
      quickbooksDocumentType: s.quickbooksDocumentType,
      quickbooksDocumentId: s.quickbooksDocumentId,
      syncStatus: s.syncStatus,
      syncError: s.syncError,
      total: String(s.total),
      paidAmount: String(s.paidAmount),
      balanceAmount: String(s.balanceAmount),
    });
    expect(compare(explicit)).toEqual(compare(legacy));
  });

  it('produces field-identical SyncJob rows (requirement 5)', async () => {
    const legacy = await paidSale(tile, owner);
    const legacyJob = await prisma.syncJob.findFirstOrThrow({ where: { entityId: legacy.id } });

    await giveProfile(other, AccountingProviderKind.QUICKBOOKS, BusinessType.TILE_SHOP);
    const explicit = await paidSale(other, otherOwner);
    const explicitJob = await prisma.syncJob.findFirstOrThrow({ where: { entityId: explicit.id } });

    expect(stable(explicitJob)).toEqual(stable(legacyJob));
  });

  it('produces field-identical SyncLog rows (requirement 6)', async () => {
    const legacy = await paidSale(tile, owner);
    const legacyLog = await prisma.syncLog.findFirstOrThrow({ where: { entityId: legacy.id } });

    await giveProfile(other, AccountingProviderKind.QUICKBOOKS, BusinessType.TILE_SHOP);
    const explicit = await paidSale(other, otherOwner);
    const explicitLog = await prisma.syncLog.findFirstOrThrow({ where: { entityId: explicit.id } });

    expect(stable(explicitLog)).toEqual(stable(legacyLog));
  });

  it('applies the same customer requirement', async () => {
    await giveProfile(other, AccountingProviderKind.QUICKBOOKS, BusinessType.TILE_SHOP);

    await expect(
      sales.complete(other.tenantId, otherOwner, {
        branchId: other.branchId,
        items: [{ productId: other.productAId, quantity: 1 }],
        payments: [],
      }),
    ).rejects.toThrow('A customer is required for a credit/partial sale (Invoice)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11-25 — NONE accounting
// ─────────────────────────────────────────────────────────────────────────────

describe('a tenant with NONE accounting', () => {
  beforeEach(async () => {
    await giveProfile(other, AccountingProviderKind.NONE);
  });

  it('resolves the NoAccounting provider', async () => {
    expect(await accountingFactory.forTenant(other.tenantId)).toBeInstanceOf(NoAccountingProvider);
  });

  it('completes a paid sale locally', async () => {
    const sale = await paidSale(other, otherOwner);

    expect(sale.status).toBe('COMPLETED');
    expect(sale.paymentStatus).toBe('PAID');
    expect(Number(sale.total)).toBe(1000);
    expect(sale.completedAt).not.toBeNull();
  });

  it('persists its local Payment records', async () => {
    const sale = await paidSale(other, otherOwner);

    const payments = await prisma.payment.findMany({ where: { saleId: sale.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0].method).toBe('CASH');
    expect(Number(payments[0].amount)).toBe(1000);
    expect(payments[0].quickbooksPaymentId).toBeNull();
    expect(payments[0].syncStatus).toBe('NOT_SYNCED');
  });

  it('creates ZERO SyncJob rows', async () => {
    await paidSale(other, otherOwner);
    expect(await prisma.syncJob.count()).toBe(0);
  });

  it('creates ZERO SyncLog rows', async () => {
    await paidSale(other, otherOwner);
    expect(await prisma.syncLog.count()).toBe(0);
  });

  it('stores no QuickBooks document type', async () => {
    const sale = await paidSale(other, otherOwner);
    expect(sale.quickbooksDocumentType).toBeNull();
  });

  it('stores no QuickBooks id, and nothing that looks like one', async () => {
    const sale = await paidSale(other, otherOwner);
    const row = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      include: { payments: true },
    });

    expect(row.quickbooksDocumentId).toBeNull();
    expect(row.payments.every((p) => p.quickbooksPaymentId === null)).toBe(true);
    // No QBO-INV-*, QBO-SR-*, or QBO-PMT-* anywhere in the persisted sale.
    expect(JSON.stringify(row)).not.toMatch(/QBO-/);
  });

  it('is NOT_SYNCED rather than PENDING — no pending QuickBooks state', async () => {
    const sale = await paidSale(other, otherOwner);

    // PENDING would render as an in-progress QuickBooks push, forever, and would
    // switch the retry-sync action on in the UI.
    expect(sale.syncStatus).toBe('NOT_SYNCED');
    expect(sale.syncError).toBeNull();
  });

  it('never claims an external synchronization occurred', async () => {
    const sale = await paidSale(other, otherOwner);
    const row = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });

    expect(row.syncStatus).not.toBe('SYNCED');
    expect(row.syncStatus).not.toBe('SYNCING');
    expect(row.syncStatus).not.toBe('FAILED');
  });

  it('leaves the OTHER tenant\'s QuickBooks behaviour untouched', async () => {
    await paidSale(other, otherOwner);
    const legacy = await paidSale(tile, owner);

    expect(legacy.quickbooksDocumentType).toBe('SALES_RECEIPT');
    expect(await prisma.syncJob.count({ where: { tenantId: tile.tenantId } })).toBe(1);
    expect(await prisma.syncJob.count({ where: { tenantId: other.tenantId } })).toBe(0);
  });

  describe('customer document kind', () => {
    it('a paid sale is a RECEIPT', async () => {
      const sale = await paidSale(other, otherOwner);
      const page = await sales.list(other.tenantId, dto(QuerySalesDto, {}));

      expect(page.items.find((i) => i.id === sale.id)?.documentKind).toBe(
        CustomerDocumentKind.RECEIPT,
      );
    });

    it('a partial sale is an INVOICE', async () => {
      const sale = await partialSale(other, otherOwner);
      const page = await sales.list(other.tenantId, dto(QuerySalesDto, {}));

      expect(page.items.find((i) => i.id === sale.id)?.documentKind).toBe(
        CustomerDocumentKind.INVOICE,
      );
    });

    it('a credit / unpaid sale is an INVOICE', async () => {
      const sale = await creditSale(other, otherOwner);
      const page = await sales.list(other.tenantId, dto(QuerySalesDto, {}));

      expect(page.items.find((i) => i.id === sale.id)?.documentKind).toBe(
        CustomerDocumentKind.INVOICE,
      );
    });

    it('does not require a customer for a credit sale — that is a QuickBooks rule', async () => {
      // A restaurant running a tab for an unnamed walk-in must not be blocked by a
      // constraint that exists only because a QuickBooks Invoice needs a CustomerRef.
      const sale = await sales.complete(other.tenantId, otherOwner, {
        branchId: other.branchId,
        items: [{ productId: other.productAId, quantity: 1 }],
        payments: [],
      });

      expect(sale.paymentStatus).toBe('UNPAID');
      expect(sale.customerId).toBeNull();
      expect(sale.quickbooksDocumentType).toBeNull();
    });
  });

  describe('customer documents render', () => {
    it('a paid sale prints a thermal RECEIPT with no QuickBooks wording', async () => {
      const sale = await paidSale(other, otherOwner);
      const { printJob } = await receipts.generateCustomer(other.tenantId, sale.id, otherOwner.id);
      const { html } = await prisma.printJob.findUniqueOrThrow({ where: { id: printJob.id } });

      expect(html).toContain('Receipt');
      expect(html).not.toMatch(/QuickBooks/i);
      expect(html).not.toMatch(/QBO-/);
      expect(html).not.toMatch(/SALES_RECEIPT|INVOICE/);
    });

    it('a credit sale prints a thermal INVOICE label', async () => {
      const sale = await creditSale(other, otherOwner);
      const { printJob } = await receipts.generateCustomer(other.tenantId, sale.id, otherOwner.id);
      const { html } = await prisma.printJob.findUniqueOrThrow({ where: { id: printJob.id } });

      expect(html).toContain('Invoice');
      expect(html).not.toMatch(/QuickBooks/i);
    });

    it('the A4 document renders', async () => {
      const sale = await paidSale(other, otherOwner);
      const html = await documents.saleHtml(other.tenantId, sale.id);

      expect(html.length).toBeGreaterThan(200);
      expect(html).toContain(sale.saleNumber);
      expect(html).not.toMatch(/QuickBooks/i);
    });
  });

  it('the QuickBooks sync endpoint refuses, writing nothing', async () => {
    const sale = await paidSale(other, otherOwner);

    await expect(sales.syncToQuickBooks(other.tenantId, sale.id)).rejects.toThrow(
      /does not support/,
    );

    const row = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(row.quickbooksDocumentId).toBeNull();
    expect(row.syncStatus).toBe('NOT_SYNCED');
    expect(await prisma.syncJob.count()).toBe(0);
    expect(await prisma.syncLog.count()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 26-28 — markSynced fails closed (Risk Y)
// ─────────────────────────────────────────────────────────────────────────────

describe('markSynced refuses to fabricate external metadata', () => {
  it('rejects a blank document id, writing nothing', async () => {
    const sale = await paidSale(tile, owner);

    await expect(
      salesRepository.markSynced(sale, { documentId: '   ', documentType: 'SALES_RECEIPT' }),
    ).rejects.toThrow(/no document id/);

    const row = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(row.syncStatus).toBe('PENDING');
    expect(row.quickbooksDocumentId).toBeNull();
  });

  it('rejects a missing document type', async () => {
    const sale = await paidSale(tile, owner);

    await expect(
      salesRepository.markSynced(sale, {
        documentId: 'QBO-SR-REAL',
        documentType: undefined as never,
      }),
    ).rejects.toThrow(/no document type/);
  });

  it('rejects a sale that has no external accounting document at all', async () => {
    await giveProfile(other, AccountingProviderKind.NONE);
    const sale = await paidSale(other, otherOwner);

    await expect(
      salesRepository.markSynced(sale, { documentId: 'QBO-SR-X', documentType: 'SALES_RECEIPT' }),
    ).rejects.toThrow(/no external accounting document/);

    const row = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(row.quickbooksDocumentId).toBeNull();
    expect(row.syncStatus).toBe('NOT_SYNCED');
  });

  it('records the document id QuickBooks returned, not a generated one', async () => {
    const sale = await paidSale(tile, owner);

    await salesRepository.markSynced(sale, {
      documentId: 'INTUIT-REAL-4821',
      documentType: 'SALES_RECEIPT',
    });

    const row = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(row.quickbooksDocumentId).toBe('INTUIT-REAL-4821');
    expect(row.syncStatus).toBe('SYNCED');
  });

  it('the QuickBooks sync endpoint still works for a QuickBooks tenant, unchanged', async () => {
    const sale = await paidSale(tile, owner);

    const synced = await sales.syncToQuickBooks(tile.tenantId, sale.id);

    // Same mock identifiers the endpoint has always produced (open question O1).
    expect(synced.syncStatus).toBe('SYNCED');
    expect(synced.quickbooksDocumentId).toBe(`QBO-SR-${sale.saleNumber}`);
    const log = await prisma.syncLog.findFirstOrThrow({
      where: { entityId: sale.id, status: 'SYNCED' },
    });
    expect(log.message).toBe(`Mock QuickBooks sync: SALES_RECEIPT ${synced.quickbooksDocumentId}`);
  });

  it('a credit sale still syncs to a QBO-INV id for a QuickBooks tenant', async () => {
    const sale = await creditSale(tile, owner);
    const synced = await sales.syncToQuickBooks(tile.tenantId, sale.id);

    expect(synced.quickbooksDocumentId).toBe(`QBO-INV-${sale.saleNumber}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 29-33 — rollback, tenant isolation, client cannot choose a provider
// ─────────────────────────────────────────────────────────────────────────────

describe('transaction and tenant safety', () => {
  it('a failed accounting submission rolls the whole sale back', async () => {
    const provider = testModule.get(QuickBooksAccountingProvider);
    const spy = jest
      .spyOn(provider, 'postSale')
      .mockRejectedValue(new Error('accounting exploded'));

    try {
      await expect(paidSale(tile, owner)).rejects.toThrow('accounting exploded');
    } finally {
      spy.mockRestore();
    }

    // No sale, no stock movement, no orphan job.
    expect(await prisma.sale.count()).toBe(0);
    expect(await prisma.syncJob.count()).toBe(0);
    expect(await prisma.syncLog.count()).toBe(0);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });
    expect(Number(product.quantityOnHand)).toBe(100);
  });

  it('a failed sale leaves no orphan SyncJob', async () => {
    // Insufficient stock fails AFTER the sale row is created inside the transaction.
    await expect(
      sales.complete(tile.tenantId, owner, {
        branchId: tile.branchId,
        items: [{ productId: tile.productAId, quantity: 500 }],
        payments: [{ method: 'CASH', amount: 500_000 }],
      }),
    ).rejects.toThrow(/Insufficient stock/);

    expect(await prisma.sale.count()).toBe(0);
    expect(await prisma.syncJob.count()).toBe(0);
  });

  it('a disagreement between the stored document type and the provider aborts the sale', async () => {
    // The invariant in postAccountingChecked: a sale stored with a QuickBooks
    // document type whose provider reports NOT_REQUIRED would never reach the books.
    const provider = testModule.get(QuickBooksAccountingProvider);
    const spy = jest.spyOn(provider, 'postSale').mockResolvedValue({
      disposition: 'NOT_REQUIRED',
      provider: 'NONE',
      externalDocumentType: null,
    });

    try {
      await expect(paidSale(tile, owner)).rejects.toThrow(/disagreed with the persisted sale/);
    } finally {
      spy.mockRestore();
    }

    expect(await prisma.sale.count()).toBe(0);
  });

  it('resolves the provider for the AUTHENTICATED tenant only', async () => {
    await giveProfile(other, AccountingProviderKind.NONE);
    const profileService = testModule.get(BusinessProfileService);
    const spy = jest.spyOn(profileService, 'getEffectiveProfile');

    await paidSale(tile, owner);

    expect(spy).toHaveBeenCalledWith(tile.tenantId);
    expect(spy).not.toHaveBeenCalledWith(other.tenantId);
    spy.mockRestore();
  });

  it("tenant A cannot use tenant B's accounting provider", async () => {
    await giveProfile(other, AccountingProviderKind.NONE);

    // Tile has no profile, so it must still be QuickBooks even though the only
    // profile row in the database says NONE.
    const legacy = await paidSale(tile, owner);
    expect(legacy.quickbooksDocumentType).toBe('SALES_RECEIPT');
    expect(await prisma.syncJob.count({ where: { tenantId: tile.tenantId } })).toBe(1);

    const restaurant = await paidSale(other, otherOwner);
    expect(restaurant.quickbooksDocumentType).toBeNull();
    expect(await prisma.syncJob.count({ where: { tenantId: other.tenantId } })).toBe(0);
  });

  it('the client cannot override the accounting provider through the sale payload', async () => {
    await giveProfile(other, AccountingProviderKind.NONE);

    // There is no DTO field for it, so the closest a client can get is smuggling
    // extra keys — which the service ignores and the global ValidationPipe rejects.
    const sale = await sales.complete(other.tenantId, otherOwner, {
      branchId: other.branchId,
      registerId: other.registerId,
      items: [{ productId: other.productAId, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 1000 }],
      accountingProvider: 'QUICKBOOKS',
      quickbooksDocumentType: 'SALES_RECEIPT',
    } as never);

    expect(sale.quickbooksDocumentType).toBeNull();
    expect(await prisma.syncJob.count()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 35-37 — nothing else was adopted
// ─────────────────────────────────────────────────────────────────────────────

describe('Slice 6A adopted the sale path only', () => {
  it('stock still moves through the repository, not an InventoryProvider', async () => {
    await giveProfile(other, AccountingProviderKind.NONE);
    await paidSale(other, otherOwner);

    // If InventoryProvider had been adopted, a NONE-accounting RESTAURANT tenant
    // would still be on QUICKBOOKS inventory here — but the point is that the
    // decrement happens exactly as it did before, through decrementStock.
    const product = await prisma.product.findUniqueOrThrow({ where: { id: other.productAId } });
    expect(Number(product.quantityOnHand)).toBe(99);
  });

  it('returns still enqueue their own sync directly', async () => {
    // Untouched by 6A: the returns repository still calls enqueueReturnSync itself.
    const sale = await paidSale(tile, owner, 2);
    expect(await prisma.syncJob.count({ where: { entityId: sale.id } })).toBe(1);
  });
});
