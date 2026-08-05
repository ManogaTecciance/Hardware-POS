/**
 * Slice 6B — the completed-return workflow now goes through `AccountingProvider`.
 *
 * Three claims, and the third is the one that makes returns harder than sales:
 *
 *  1. **Nothing changed for QuickBooks tenants.** The adoption is an extraction, so
 *     a legacy return must produce the same document type, the same `SyncJob` and
 *     `SyncLog` rows, the same restock, the same error wording, and the same
 *     rendered documents as before.
 *
 *  2. **A `NONE` tenant is genuinely local.** No outbox rows, no QuickBooks
 *     identifier, no external document type, no "pending sync" state — while still
 *     completing a valid return that restocks correctly.
 *
 *  3. **Provenance beats the current profile.** A return reverses the accounting
 *     entry the ORIGINAL SALE created. A tenant that switches providers afterwards
 *     must not change where its existing sales get reversed, in either direction.
 *     That is what the `provenance` block below is for, and it is the reason
 *     `AccountingProviderFactory.forSale` exists alongside `forTenant`.
 */

import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  type PrismaClient,
} from '@hardware-pos/database';

import { validateEnv } from '../../../src/config/env.validation';
import { StorageModule } from '../../../src/common/storage/storage.module';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { DocumentsModule } from '../../../src/modules/documents/documents.module';
import { DocumentsService } from '../../../src/modules/documents/documents.service';
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { SalesService } from '../../../src/modules/sales/sales.service';
import { ReturnsModule } from '../../../src/modules/returns/returns.module';
import { ReturnsService } from '../../../src/modules/returns/returns.service';
import { QuickBooksModule } from '../../../src/modules/quickbooks/quickbooks.module';
import { QuickBooksReturnsSyncService } from '../../../src/modules/quickbooks/quickbooks-returns-sync.service';
import { CustomerReturnDocumentKind } from '../../../src/modules/returns/customer-return-document';
import { AccountingProviderFactory } from '../../../src/modules/providers/accounting/accounting-provider.factory';
import { AmbiguousAccountingProvenanceError } from '../../../src/modules/providers/provider.errors';
import type { AccountingProvider } from '../../../src/modules/providers/accounting/accounting-provider';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';
import { CreateReturnDto } from '../../../src/modules/returns/dto/create-return.dto';
import { ApproveReturnDto } from '../../../src/modules/returns/dto/approve-return.dto';
import { PreviewReturnDto } from '../../../src/modules/returns/dto/preview-return.dto';
import { QueryReturnsDto } from '../../../src/modules/returns/dto/query-returns.dto';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { dto } from '../dto';
import {
  MANAGER_PIN,
  seedSecondTenant,
  seedTileShopWithQuickBooks,
  type SeededTenant,
} from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let sales: SalesService;
let returns: ReturnsService;
let documents: DocumentsService;
let returnsSync: QuickBooksReturnsSyncService;
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
      ReturnsModule,
      DocumentsModule,
      QuickBooksModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();

  sales = testModule.get(SalesService);
  returns = testModule.get(ReturnsService);
  documents = testModule.get(DocumentsService);
  returnsSync = testModule.get(QuickBooksReturnsSyncService);
  accountingFactory = testModule.get(AccountingProviderFactory);
});

afterAll(async () => {
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  await resetDatabase(prisma);
  tile = await seedTileShopWithQuickBooks(prisma);
  other = await seedSecondTenant(prisma);
  owner = { id: tile.ownerId, tenantId: tile.tenantId, role: 'OWNER' };
  otherOwner = { id: other.ownerId, tenantId: other.tenantId, role: 'OWNER' };
});

// ── fixtures ────────────────────────────────────────────────────────────────

async function giveProfile(
  tenant: SeededTenant,
  accountingProvider: AccountingProviderKind,
  businessType: BusinessType = BusinessType.RESTAURANT,
): Promise<void> {
  await prisma.tenantBusinessProfile.upsert({
    where: { tenantId: tenant.tenantId },
    update: { accountingProvider, businessType },
    create: {
      tenantId: tenant.tenantId,
      businessType,
      // Deliberately QUICKBOOKS: Slice 6B adopts accounting only, and pinning
      // inventory here keeps a failure attributable to the accounting change.
      inventoryMode: InventoryMode.QUICKBOOKS,
      accountingProvider,
    },
  });
}

/** A paid CASH sale of `quantity` units of product A @ 1000 each. */
function paidSale(tenant: SeededTenant, actor: AuthenticatedUser, quantity = 2) {
  return sales.complete(tenant.tenantId, actor, {
    branchId: tenant.branchId,
    registerId: tenant.registerId,
    items: [{ productId: tenant.productAId, quantity }],
    payments: [{ method: 'CASH', amount: 1000 * quantity }],
  });
}

/** A fully unpaid credit sale. `customerId` is required only under QuickBooks. */
function creditSale(tenant: SeededTenant, actor: AuthenticatedUser, withCustomer = true) {
  return sales.complete(tenant.tenantId, actor, {
    branchId: tenant.branchId,
    ...(withCustomer ? { customerId: tenant.creditCustomerId } : {}),
    items: [{ productId: tenant.productAId, quantity: 2 }],
    payments: [],
  });
}

/**
 * A partially-paid sale: 2000 owed, 1200 paid.
 *
 * Paid enough that a 1000 cash refund is allowed — `validateRefundMethod` caps a
 * cash refund at the amount actually paid, and that existing rule is obeyed here
 * rather than worked around.
 */
function partialSale(tenant: SeededTenant, actor: AuthenticatedUser, withCustomer = true) {
  return sales.complete(tenant.tenantId, actor, {
    branchId: tenant.branchId,
    ...(withCustomer ? { customerId: tenant.creditCustomerId } : {}),
    items: [{ productId: tenant.productAId, quantity: 2 }],
    payments: [{ method: 'CASH', amount: 1200 }],
  });
}

/** A paid sale with a saved customer — store credit requires one. */
function paidSaleWithCustomer(tenant: SeededTenant, actor: AuthenticatedUser) {
  return sales.complete(tenant.tenantId, actor, {
    branchId: tenant.branchId,
    customerId: tenant.creditCustomerId,
    items: [{ productId: tenant.productAId, quantity: 2 }],
    payments: [{ method: 'CASH', amount: 2000 }],
  });
}

/**
 * Disconnect QuickBooks so the worker takes its documented offline path.
 *
 * The tile-shop fixture seeds an ACTIVE connection with placeholder credentials,
 * so a worker run would attempt a real Intuit call and fail. Deactivating it
 * exercises `mockSync`, which is the deterministic path and the one whose output
 * (`QBO-RR-…` / `QBO-CM-…`) must not change.
 */
function disconnectQuickBooks(tenant: SeededTenant) {
  return prisma.quickBooksConnection.updateMany({
    where: { tenantId: tenant.tenantId },
    data: { isActive: false },
  });
}

async function managerApproval(
  tenant: SeededTenant,
  saleId: string,
  refundTotal: number,
): Promise<string> {
  const approval = await returns.approve(
    tenant.tenantId,
    dto(ApproveReturnDto, { managerPin: MANAGER_PIN, originalSaleId: saleId, refundTotal }),
  );
  if (!approval.approved || !approval.approvalToken) {
    throw new Error(`Fixture approval refused: ${approval.reason ?? 'unknown'}`);
  }
  return approval.approvalToken;
}

/**
 * Return one unit of a sale.
 *
 * `approve` mints a real manager token rather than bypassing the rule, so the
 * fixture obeys the same approval policy production does.
 */
async function returnOneUnit(
  tenant: SeededTenant,
  actor: AuthenticatedUser,
  saleId: string,
  opts: { refundMethod?: string; approve?: boolean; idempotencyKey?: string | null } = {},
) {
  const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId } });
  const approvalToken = opts.approve ? await managerApproval(tenant, saleId, 1000) : undefined;

  return returns.complete(
    tenant.tenantId,
    actor,
    dto(CreateReturnDto, {
      originalSaleId: saleId,
      refundMethod: opts.refundMethod ?? 'CASH',
      ...(approvalToken ? { approvalToken } : {}),
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
    opts.idempotencyKey ?? null,
  );
}

/** Identity and timing differ between two runs; everything else must not. */
const VOLATILE = [
  'id',
  'entityId',
  'createdAt',
  'updatedAt',
  'scheduledAt',
  'startedAt',
  'completedAt',
  'tenantId',
];
function stable<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !VOLATILE.includes(k)));
}

function syncRowsFor(returnId: string) {
  return Promise.all([
    prisma.syncJob.count({ where: { entityType: 'RETURN', entityId: returnId } }),
    prisma.syncLog.count({ where: { entityType: 'RETURN', entityId: returnId } }),
  ]);
}

/** A provider that fails inside the transaction, to prove rollback. */
function explodingProvider(base: AccountingProvider): AccountingProvider {
  return {
    ...base,
    provider: base.provider,
    name: base.name,
    resolveSaleDocumentType: base.resolveSaleDocumentType.bind(base),
    resolveReturnDocumentType: base.resolveReturnDocumentType.bind(base),
    postSale: base.postSale.bind(base),
    synchronize: base.synchronize.bind(base),
    postReturn: () => Promise.reject(new Error('accounting exploded')),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1-14 — QuickBooks compatibility
// ─────────────────────────────────────────────────────────────────────────────

describe('legacy tenant (no profile row) returns are unchanged', () => {
  it('1 — a paid-sale return is a REFUND_RECEIPT, PENDING, with one SyncJob', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    expect(ret.quickbooksDocumentType).toBe('REFUND_RECEIPT');
    expect(ret.syncStatus).toBe('PENDING');
    expect(ret.status).toBe('COMPLETED');
    expect(ret.refundStatus).toBe('COMPLETED');
    expect(await prisma.syncJob.count({ where: { entityId: ret.id } })).toBe(1);
    expect(await prisma.tenantBusinessProfile.count()).toBe(0);
  });

  it('2 — a credit-sale return is a CREDIT_MEMO, PENDING, with one SyncJob', async () => {
    const sale = await creditSale(tile, owner);
    // Credit customer + refund method unlike the (absent) original payment.
    const ret = await returnOneUnit(tile, owner, sale.id, {
      refundMethod: 'CARD',
      approve: true,
    });

    expect(ret.quickbooksDocumentType).toBe('CREDIT_MEMO');
    expect(ret.syncStatus).toBe('PENDING');
    expect(await prisma.syncJob.count({ where: { entityId: ret.id } })).toBe(1);
  });

  it('3 — a partial-payment return is a CREDIT_MEMO', async () => {
    const sale = await partialSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id, { approve: true });

    expect(ret.quickbooksDocumentType).toBe('CREDIT_MEMO');
    expect(ret.syncStatus).toBe('PENDING');
  });

  it('4 — a STORE_CREDIT refund is a CREDIT_MEMO whatever the sale status', async () => {
    const sale = await paidSaleWithCustomer(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id, {
      refundMethod: 'STORE_CREDIT',
      approve: true,
    });

    expect(ret.quickbooksDocumentType).toBe('CREDIT_MEMO');
    expect(ret.refundPayments[0].method).toBe('STORE_CREDIT');
  });

  it('6/7 — the Refund Receipt vs Credit Memo decision is unchanged across the matrix', async () => {
    const paid = await paidSale(tile, owner);
    const partial = await partialSale(tile, owner);

    expect((await returnOneUnit(tile, owner, paid.id)).quickbooksDocumentType).toBe(
      'REFUND_RECEIPT',
    );
    expect(
      (await returnOneUnit(tile, owner, partial.id, { approve: true })).quickbooksDocumentType,
    ).toBe('CREDIT_MEMO');
  });

  it('14 — GOOD stock marked RETURN_TO_STOCK is restocked eagerly, exactly as before', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });
    const sale = await paidSale(tile, owner);
    const afterSale = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });
    expect(Number(afterSale.quantityOnHand)).toBe(Number(before.quantityOnHand) - 2);

    await returnOneUnit(tile, owner, sale.id);

    const afterReturn = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });
    expect(Number(afterReturn.quantityOnHand)).toBe(Number(before.quantityOnHand) - 1);
  });

  it('14 — a DAMAGED item is still not restocked', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });
    const sale = await paidSale(tile, owner);
    const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });

    await returns.complete(
      tile.tenantId,
      owner,
      dto(CreateReturnDto, {
        originalSaleId: sale.id,
        refundMethod: 'CASH',
        approvalToken: await managerApproval(tile, sale.id, 1000),
        items: [
          {
            saleItemId: saleItem.id,
            returnQuantity: 1,
            returnReason: 'DAMAGED',
            itemCondition: 'DAMAGED',
            stockDisposition: 'DAMAGED_STOCK',
          },
        ],
      }),
      null,
    );

    const after = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });
    expect(Number(after.quantityOnHand)).toBe(Number(before.quantityOnHand) - 2);
  });
});

describe('5 — an explicit QUICKBOOKS tenant matches the legacy tenant exactly', () => {
  it('produces an identical Return row', async () => {
    const legacySale = await paidSale(tile, owner);
    const legacy = await returnOneUnit(tile, owner, legacySale.id);

    await giveProfile(tile, AccountingProviderKind.QUICKBOOKS, BusinessType.HARDWARE);
    const explicitSale = await paidSale(tile, owner);
    const explicit = await returnOneUnit(tile, owner, explicitSale.id);

    const compare = (r: typeof legacy) => ({
      quickbooksDocumentType: r.quickbooksDocumentType,
      quickbooksDocumentId: r.quickbooksDocumentId,
      syncStatus: r.syncStatus,
      status: r.status,
      refundStatus: r.refundStatus,
      refundMethod: r.refundMethod,
      refundTotal: String(r.refundTotal),
      subtotal: String(r.subtotal),
      taxAdjustment: String(r.taxAdjustment),
    });
    expect(compare(explicit)).toEqual(compare(legacy));
  });
});

describe('8/9 — SyncJob and SyncLog shapes are unchanged', () => {
  it('the job a legacy return writes is field-for-field the job an explicit tenant writes', async () => {
    const legacySale = await paidSale(tile, owner);
    const legacy = await returnOneUnit(tile, owner, legacySale.id);
    const legacyJob = await prisma.syncJob.findFirstOrThrow({ where: { entityId: legacy.id } });

    await giveProfile(tile, AccountingProviderKind.QUICKBOOKS);
    const explicitSale = await paidSale(tile, owner);
    const explicit = await returnOneUnit(tile, owner, explicitSale.id);
    const explicitJob = await prisma.syncJob.findFirstOrThrow({ where: { entityId: explicit.id } });

    expect(stable(explicitJob)).toEqual(stable(legacyJob));
    expect(legacyJob.entityType).toBe('RETURN');
    expect(legacyJob.direction).toBe('OUTBOUND');
    expect(legacyJob.status).toBe('PENDING');
  });

  it('the worker writes the same SyncLog for both', async () => {
    await disconnectQuickBooks(tile);
    const legacySale = await paidSale(tile, owner);
    const legacy = await returnOneUnit(tile, owner, legacySale.id);
    await returnsSync.syncReturn(tile.tenantId, legacy.id);
    const legacyLog = await prisma.syncLog.findFirstOrThrow({ where: { entityId: legacy.id } });

    await giveProfile(tile, AccountingProviderKind.QUICKBOOKS);
    const explicitSale = await paidSale(tile, owner);
    const explicit = await returnOneUnit(tile, owner, explicitSale.id);
    await returnsSync.syncReturn(tile.tenantId, explicit.id);
    const explicitLog = await prisma.syncLog.findFirstOrThrow({ where: { entityId: explicit.id } });

    expect(stable(explicitLog)).toEqual(stable(legacyLog));
  });
});

describe('10/11 — the QuickBooks return worker and its retry are unchanged', () => {
  it('10 — the worker still produces QBO-RR-<returnNumber> and marks the return SYNCED', async () => {
    await disconnectQuickBooks(tile);
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    const result = await returnsSync.syncReturn(tile.tenantId, ret.id);

    expect(result.status).toBe('SYNCED');
    expect(result.quickbooksDocumentId).toBe(`QBO-RR-${ret.returnNumber}`);
    const row = await prisma.return.findUniqueOrThrow({ where: { id: ret.id } });
    expect(row.syncStatus).toBe('SYNCED');
    expect(row.quickbooksDocumentId).toBe(`QBO-RR-${ret.returnNumber}`);
  });

  it('10 — a credit memo still produces QBO-CM-<returnNumber>', async () => {
    await disconnectQuickBooks(tile);
    const sale = await paidSaleWithCustomer(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id, {
      refundMethod: 'STORE_CREDIT',
      approve: true,
    });

    const result = await returnsSync.syncReturn(tile.tenantId, ret.id);

    expect(result.quickbooksDocumentId).toBe(`QBO-CM-${ret.returnNumber}`);
  });

  it('10 — the worker is still idempotent for an already-synced return', async () => {
    await disconnectQuickBooks(tile);
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);
    await returnsSync.syncReturn(tile.tenantId, ret.id);
    const logsAfterFirst = await prisma.syncLog.count({ where: { entityId: ret.id } });

    const again = await returnsSync.syncReturn(tile.tenantId, ret.id);

    expect(again.message).toBe('Return already synced');
    expect(await prisma.syncLog.count({ where: { entityId: ret.id } })).toBe(logsAfterFirst);
  });

  it('11 — retry-sync still requeues a QuickBooks return', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);
    await prisma.return.update({ where: { id: ret.id }, data: { syncStatus: 'FAILED' } });

    const result = await returns.retrySync(tile.tenantId, ret.id);

    expect(result.syncStatus).toBe('PENDING');
    const job = await prisma.syncJob.findFirstOrThrow({ where: { entityId: ret.id } });
    expect(job.status).toBe('PENDING');
  });
});

describe('12/13 — rendered return documents are unchanged for QuickBooks', () => {
  it('13 — the thermal receipt still says "Refund Receipt" for a paid-sale cash return', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    const { html } = await returns.generateReceipt(tile.tenantId, ret.id, owner.id);

    expect(html).toContain('Refund Receipt');
    expect(html).not.toContain('Credit Note');
  });

  it('13 — the thermal receipt still says "Credit Memo", not the local "Credit Note"', async () => {
    const sale = await paidSaleWithCustomer(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id, {
      refundMethod: 'STORE_CREDIT',
      approve: true,
    });

    const { html } = await returns.generateReceipt(tile.tenantId, ret.id, owner.id);

    expect(html).toContain('Credit Memo');
    expect(html).not.toContain('Credit Note');
  });

  /**
   * The strongest form of "the customer-facing document is unchanged": for a
   * partially-paid sale the LOCAL rule and the QuickBooks rule genuinely disagree
   * (local says refund receipt, QuickBooks says credit memo). The rendered
   * document must still follow QuickBooks, because the external document type
   * stays authoritative wherever one exists.
   */
  it('13 — where local and QuickBooks semantics diverge, a QuickBooks tenant still sees QuickBooks', async () => {
    const sale = await partialSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id, { approve: true });

    expect(ret.quickbooksDocumentType).toBe('CREDIT_MEMO');
    const { html } = await returns.generateReceipt(tile.tenantId, ret.id, owner.id);
    expect(html).toContain('Credit Memo');
    expect(html).not.toContain('Refund Receipt');
  });

  it('12 — the A4 return document is byte-identical with and without external metadata', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    const withMetadata = await documents.returnHtml(tile.tenantId, ret.id);
    await prisma.return.update({
      where: { id: ret.id },
      data: { quickbooksDocumentType: null, quickbooksDocumentId: null, syncStatus: 'NOT_SYNCED' },
    });
    const withoutMetadata = await documents.returnHtml(tile.tenantId, ret.id);

    // The A4 renderer never reads `quickbooksDocumentType` at all.
    expect(withoutMetadata).toEqual(withMetadata);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15-29 — NONE accounting
// ─────────────────────────────────────────────────────────────────────────────

describe('NONE accounting returns complete locally', () => {
  beforeEach(async () => {
    await giveProfile(tile, AccountingProviderKind.NONE);
  });

  it('15/21/22/23/24 — a paid-sale return persists locally with no external trace', async () => {
    const sale = await paidSale(tile, owner);
    expect(sale.quickbooksDocumentType).toBeNull();

    const ret = await returnOneUnit(tile, owner, sale.id);

    expect(ret.status).toBe('COMPLETED');
    expect(ret.refundStatus).toBe('COMPLETED');
    expect(Number(ret.refundTotal)).toBe(1000);
    expect(ret.quickbooksDocumentType).toBeNull();
    expect(ret.quickbooksDocumentId).toBeNull();
    expect(ret.syncStatus).toBe('NOT_SYNCED');
    expect(await syncRowsFor(ret.id)).toEqual([0, 0]);
    expect(JSON.stringify(ret)).not.toMatch(/QBO-/);
  });

  it('15 — the ReturnItem and RefundPayment rows are still written', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    expect(ret.items).toHaveLength(1);
    expect(Number(ret.items[0].returnQuantity)).toBe(1);
    expect(ret.refundPayments).toHaveLength(1);
    expect(ret.refundPayments[0].method).toBe('CASH');
    expect(Number(ret.refundPayments[0].amount)).toBe(1000);
    expect(ret.refundPayments[0].quickbooksPaymentId).toBeNull();
    expect(ret.refundPayments[0].syncStatus).toBe('NOT_SYNCED');
  });

  it('16 — a credit-sale return completes with no customer at all', async () => {
    // Only QuickBooks requires a customer for a credit sale, so a NONE tenant can
    // run an unnamed tab — and can then return against it.
    const sale = await creditSale(tile, owner, false);
    expect(sale.customerId).toBeNull();

    const ret = await returnOneUnit(tile, owner, sale.id, { refundMethod: 'CARD' });

    expect(ret.status).toBe('COMPLETED');
    expect(ret.quickbooksDocumentType).toBeNull();
    expect(await syncRowsFor(ret.id)).toEqual([0, 0]);
  });

  it('17 — a partial return of a multi-line sale completes locally', async () => {
    const sale = await sales.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      items: [
        { productId: tile.productAId, quantity: 2 },
        { productId: tile.productBId, quantity: 2 },
      ],
      payments: [{ method: 'CASH', amount: 2501 }],
    });
    const ret = await returnOneUnit(tile, owner, sale.id);

    expect(ret.items).toHaveLength(1);
    const saleRow = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(saleRow.returnStatus).toBe('PARTIALLY_RETURNED');
    expect(await syncRowsFor(ret.id)).toEqual([0, 0]);
  });

  it('18 — a monetary refund is a REFUND_RECEIPT document kind', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    const [row] = (await returns.list(tile.tenantId, dto(QueryReturnsDto, {}))).items.filter(
      (r) => r.id === ret.id,
    );
    expect(row.documentKind).toBe(CustomerReturnDocumentKind.REFUND_RECEIPT);
    expect(row.quickbooksDocumentType).toBeNull();
  });

  it('19 — a store-credit return is a CREDIT_NOTE document kind', async () => {
    const sale = await sales.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      customerId: tile.creditCustomerId,
      items: [{ productId: tile.productAId, quantity: 2 }],
      payments: [{ method: 'CASH', amount: 2000 }],
    });
    const ret = await returnOneUnit(tile, owner, sale.id, {
      refundMethod: 'STORE_CREDIT',
      approve: true,
    });

    const [row] = (await returns.list(tile.tenantId, dto(QueryReturnsDto, {}))).items.filter(
      (r) => r.id === ret.id,
    );
    expect(row.documentKind).toBe(CustomerReturnDocumentKind.CREDIT_NOTE);
  });

  it('20 — reducing an unpaid balance is a CREDIT_NOTE document kind', async () => {
    const sale = await creditSale(tile, owner, false);
    const ret = await returnOneUnit(tile, owner, sale.id, { refundMethod: 'CARD' });

    const [row] = (await returns.list(tile.tenantId, dto(QueryReturnsDto, {}))).items.filter(
      (r) => r.id === ret.id,
    );
    expect(row.documentKind).toBe(CustomerReturnDocumentKind.CREDIT_NOTE);
  });

  it('25 — the QuickBooks return worker refuses a NONE return instead of inventing an id', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    await expect(returnsSync.syncReturn(tile.tenantId, ret.id)).rejects.toThrow(
      'has no external accounting document and cannot be synced to QuickBooks',
    );

    const row = await prisma.return.findUniqueOrThrow({ where: { id: ret.id } });
    expect(row.quickbooksDocumentId).toBeNull();
    expect(row.syncStatus).toBe('NOT_SYNCED');
    expect(await syncRowsFor(ret.id)).toEqual([0, 0]);
  });

  it('26 — the thermal return receipt shows no QuickBooks wording', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    const { html } = await returns.generateReceipt(tile.tenantId, ret.id, owner.id);

    expect(html).not.toMatch(/QuickBooks/i);
    expect(html).not.toMatch(/QBO-/);
    expect(html).not.toContain('NOT_SYNCED');
    expect(html).not.toContain('Credit Memo');
    expect(html).toContain('Refund Receipt');
  });

  it('26 — a store-credit return prints "Credit Note", the local vocabulary', async () => {
    const sale = await sales.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      customerId: tile.creditCustomerId,
      items: [{ productId: tile.productAId, quantity: 2 }],
      payments: [{ method: 'CASH', amount: 2000 }],
    });
    const ret = await returnOneUnit(tile, owner, sale.id, {
      refundMethod: 'STORE_CREDIT',
      approve: true,
    });

    const { html } = await returns.generateReceipt(tile.tenantId, ret.id, owner.id);

    expect(html).toContain('Credit Note');
    expect(html).not.toContain('Credit Memo');
    expect(html).not.toMatch(/QuickBooks/i);
  });

  it('27 — retry-sync is refused, so the UI has no retry action to offer', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    await expect(returns.retrySync(tile.tenantId, ret.id)).rejects.toThrow(
      "does not support 'retrying an external sync'",
    );
    expect(await syncRowsFor(ret.id)).toEqual([0, 0]);
  });

  it('28 — the A4 return document renders', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    const html = await documents.returnHtml(tile.tenantId, ret.id);

    expect(html).toContain(ret.returnNumber);
    expect(html).toContain('Return / Refund');
    expect(html).not.toMatch(/QuickBooks/i);
  });

  it('29 — the thermal return document renders', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    const { html, printJobId } = await returns.generateReceipt(tile.tenantId, ret.id, owner.id);

    expect(printJobId).toBeTruthy();
    expect(html).toContain(ret.returnNumber);
  });

  it('preview advertises the same absence of an external document', async () => {
    const sale = await paidSale(tile, owner);
    const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });

    const preview = await returns.preview(
      tile.tenantId,
      owner,
      dto(PreviewReturnDto, {
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
    );

    expect(preview.quickbooksDocumentType).toBeNull();
    expect(preview.documentKind).toBe(CustomerReturnDocumentKind.REFUND_RECEIPT);
  });

  it('the local restock is identical to the QuickBooks path', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });
    const sale = await paidSale(tile, owner);
    await returnOneUnit(tile, owner, sale.id);

    const after = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });
    expect(Number(after.quantityOnHand)).toBe(Number(before.quantityOnHand) - 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 30-34 — provenance and tenant isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('30-32 — accounting provenance comes from the original sale', () => {
  it('30 — a QuickBooks sale is still reversed in QuickBooks after the tenant switches to NONE', async () => {
    const sale = await paidSale(tile, owner);
    expect(sale.quickbooksDocumentType).toBe('SALES_RECEIPT');

    // The tenant migrates off QuickBooks AFTER the sale was filed there.
    await giveProfile(tile, AccountingProviderKind.NONE);
    expect(
      (await accountingFactory.forTenant(tile.tenantId)).provider,
    ).toBe(AccountingProviderKind.NONE);

    const ret = await returnOneUnit(tile, owner, sale.id);

    // The money is in QuickBooks; the credit has to go back to QuickBooks.
    expect(ret.quickbooksDocumentType).toBe('REFUND_RECEIPT');
    expect(ret.syncStatus).toBe('PENDING');
    expect(await prisma.syncJob.count({ where: { entityId: ret.id } })).toBe(1);
  });

  it('31 — a NONE sale is NOT pushed to QuickBooks after the tenant switches to QUICKBOOKS', async () => {
    await giveProfile(tile, AccountingProviderKind.NONE);
    const sale = await paidSale(tile, owner);
    expect(sale.quickbooksDocumentType).toBeNull();

    // The tenant adopts QuickBooks AFTER the sale was recorded only locally.
    await giveProfile(tile, AccountingProviderKind.QUICKBOOKS);
    expect(
      (await accountingFactory.forTenant(tile.tenantId)).provider,
    ).toBe(AccountingProviderKind.QUICKBOOKS);

    const ret = await returnOneUnit(tile, owner, sale.id);

    // QuickBooks never saw the sale; a credit note for it would be revenue it
    // never recorded being reversed.
    expect(ret.quickbooksDocumentType).toBeNull();
    expect(ret.syncStatus).toBe('NOT_SYNCED');
    expect(await syncRowsFor(ret.id)).toEqual([0, 0]);
  });

  it('32 — a sale with contradictory provenance is refused, not guessed at', async () => {
    const sale = await paidSale(tile, owner);
    // A row no valid workflow produces: no document type, but an external id.
    await prisma.sale.update({
      where: { id: sale.id },
      data: { quickbooksDocumentType: null, quickbooksDocumentId: 'QBO-SR-ORPHAN' },
    });

    await expect(returnOneUnit(tile, owner, sale.id)).rejects.toThrow(
      AmbiguousAccountingProvenanceError,
    );
    expect(await prisma.return.count()).toBe(0);
  });

  it('32 — a sale with no document type but a sync status is also refused', async () => {
    const sale = await paidSale(tile, owner);
    await prisma.sale.update({
      where: { id: sale.id },
      data: { quickbooksDocumentType: null, syncStatus: 'SYNCED' },
    });

    await expect(returnOneUnit(tile, owner, sale.id)).rejects.toThrow(
      AmbiguousAccountingProvenanceError,
    );
    expect(await prisma.return.count()).toBe(0);
  });

  it('the provenance decision never consults the tenant profile', async () => {
    const sale = await paidSale(tile, owner);
    await giveProfile(tile, AccountingProviderKind.NONE);
    const spy = jest.spyOn(accountingFactory, 'forTenant');

    await returnOneUnit(tile, owner, sale.id);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('33/34 — tenant and branch isolation', () => {
  it('33 — tenant A cannot return tenant B’s sale', async () => {
    const sale = await paidSale(tile, owner);

    await expect(returnOneUnit(other, otherOwner, sale.id)).rejects.toThrow(
      `Sale ${sale.id} not found`,
    );
    expect(await prisma.return.count()).toBe(0);
  });

  it('33 — a cross-tenant preview is refused the same way', async () => {
    const sale = await paidSale(tile, owner);
    const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });

    await expect(
      returns.preview(
        other.tenantId,
        otherOwner,
        dto(PreviewReturnDto, {
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
      ),
    ).rejects.toThrow(`Sale ${sale.id} not found`);
  });

  it('34 — the return inherits the original sale’s branch, not one from the request', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    expect(ret.branchId).toBe(sale.branchId);
    expect(ret.tenantId).toBe(tile.tenantId);
  });

  /**
   * The real pipe, configured exactly as `main.ts` configures it. Asserting on a
   * `plainToInstance` result would prove nothing — it copies unknown keys
   * through. `forbidNonWhitelisted` is the actual guard, so it is the thing under
   * test.
   */
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const metadata = { type: 'body' as const, metatype: CreateReturnDto };
  const validReturnBody = {
    originalSaleId: 'sale-1',
    refundMethod: 'CASH',
    items: [
      {
        saleItemId: 'si-1',
        returnQuantity: 1,
        returnReason: 'CHANGED_MIND',
        itemCondition: 'GOOD',
        stockDisposition: 'RETURN_TO_STOCK',
      },
    ],
  };

  /** The pipe throws a generic BadRequest; the field names are in its payload. */
  async function rejectionMessages(body: Record<string, unknown>): Promise<string[]> {
    try {
      await pipe.transform(body, metadata);
      return [];
    } catch (err) {
      const response = (err as BadRequestException).getResponse() as { message?: string[] };
      return response.message ?? [];
    }
  }

  it('42 — a client-supplied tenantId is rejected by the request pipeline', async () => {
    expect(await rejectionMessages({ ...validReturnBody, tenantId: other.tenantId })).toContain(
      'property tenantId should not exist',
    );

    // The clean body passes, so the rejection is about the extra field only.
    await expect(pipe.transform({ ...validReturnBody }, metadata)).resolves.toBeDefined();
  });

  it.each(['accountingProvider', 'quickbooksDocumentType', 'documentKind', 'syncStatus'])(
    '41 — a client-supplied %s is rejected by the request pipeline',
    async (field) => {
      expect(await rejectionMessages({ ...validReturnBody, [field]: 'CREDIT_NOTE' })).toContain(
        `property ${field} should not exist`,
      );
    },
  );

  it('41 — a client-supplied document kind cannot change what is stored', async () => {
    const sale = await paidSale(tile, owner);
    const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });

    const ret = await returns.complete(
      tile.tenantId,
      owner,
      dto(CreateReturnDto, {
        originalSaleId: sale.id,
        refundMethod: 'CASH',
        // All ignored: the DTO does not declare them, and the server decides.
        quickbooksDocumentType: 'CREDIT_MEMO',
        documentKind: 'CREDIT_NOTE',
        syncStatus: 'SYNCED',
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

    expect(ret.quickbooksDocumentType).toBe('REFUND_RECEIPT');
    expect(ret.syncStatus).toBe('PENDING');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 35-45 — transactions and mark-synced safety
// ─────────────────────────────────────────────────────────────────────────────

describe('35-40 — a provider failure rolls the whole return back', () => {
  it('leaves no Return, ReturnItem, RefundPayment, stock change, SyncJob or SyncLog', async () => {
    const sale = await paidSale(tile, owner);
    const stockBefore = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });
    const saleItemBefore = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });

    jest
      .spyOn(accountingFactory, 'forSale')
      .mockImplementation((s) =>
        explodingProvider(
          AccountingProviderFactory.prototype.forSale.call(accountingFactory, s),
        ),
      );

    await expect(returnOneUnit(tile, owner, sale.id)).rejects.toThrow('accounting exploded');

    expect(await prisma.return.count()).toBe(0); // 35
    expect(await prisma.returnItem.count()).toBe(0); // 36
    expect(await prisma.refundPayment.count()).toBe(0); // 37

    const stockAfter = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });
    expect(Number(stockAfter.quantityOnHand)).toBe(Number(stockBefore.quantityOnHand)); // 38

    expect(
      await prisma.syncJob.count({ where: { entityType: 'RETURN' } }),
    ).toBe(0); // 39
    expect(
      await prisma.syncLog.count({ where: { entityType: 'RETURN' } }),
    ).toBe(0); // 40

    // The per-line roll-up on the original sale is rolled back too.
    const saleItemAfter = await prisma.saleItem.findUniqueOrThrow({
      where: { id: saleItemBefore.id },
    });
    expect(Number(saleItemAfter.returnedQuantity)).toBe(0);
    expect(saleItemAfter.returnStatus).toBe(saleItemBefore.returnStatus);

    const saleAfter = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(Number(saleAfter.returnedAmount)).toBe(0);
    expect(saleAfter.returnStatus).toBe('NOT_RETURNED');
  });

  it('aborts when the submission disagrees with what was persisted', async () => {
    const sale = await paidSale(tile, owner);
    const quickbooks = accountingFactory.forProvider(AccountingProviderKind.QUICKBOOKS);

    // A provider that resolves a QuickBooks document but reports NOT_REQUIRED —
    // the sale would be filed as QuickBooks while nothing was ever queued.
    jest.spyOn(accountingFactory, 'forSale').mockReturnValue({
      ...quickbooks,
      provider: quickbooks.provider,
      name: quickbooks.name,
      resolveSaleDocumentType: quickbooks.resolveSaleDocumentType.bind(quickbooks),
      resolveReturnDocumentType: quickbooks.resolveReturnDocumentType.bind(quickbooks),
      postSale: quickbooks.postSale.bind(quickbooks),
      synchronize: quickbooks.synchronize.bind(quickbooks),
      postReturn: async () => ({
        disposition: 'NOT_REQUIRED' as const,
        provider: 'NONE' as const,
        externalDocumentType: null,
      }),
    });

    await expect(returnOneUnit(tile, owner, sale.id)).rejects.toThrow(
      /Accounting submission disagreed with the persisted return/,
    );
    expect(await prisma.return.count()).toBe(0);
    expect(await prisma.syncJob.count({ where: { entityType: 'RETURN' } })).toBe(0);
  });
});

describe('43-45 — a return is marked synced only after a real external success', () => {
  it('44 — refuses a return with no external document type', async () => {
    await giveProfile(tile, AccountingProviderKind.NONE);
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    await expect(returnsSync.syncReturn(tile.tenantId, ret.id)).rejects.toThrow(
      BadRequestException,
    );

    const row = await prisma.return.findUniqueOrThrow({ where: { id: ret.id } });
    expect(row.syncStatus).toBe('NOT_SYNCED');
    expect(row.quickbooksDocumentId).toBeNull();
  });

  it('43 — refuses a blank external document id rather than storing one', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);
    const row = await prisma.return.findFirstOrThrow({
      where: { id: ret.id },
      include: { items: true, refundPayments: true, originalSale: { select: { saleNumber: true, paymentStatus: true } } },
    });

    // Reaching the private guard directly: no public path can produce a blank id
    // today, which is exactly why the guard needs its own test.
    const persistSuccess = (
      returnsSync as unknown as {
        persistSuccess(r: typeof row, id: string, attempt: number): Promise<void>;
      }
    ).persistSuccess.bind(returnsSync);

    await expect(persistSuccess(row, '   ', 1)).rejects.toThrow('QuickBooks returned no document id');

    const after = await prisma.return.findUniqueOrThrow({ where: { id: ret.id } });
    expect(after.syncStatus).toBe('PENDING');
    expect(after.quickbooksDocumentId).toBeNull();
    // The refund payment is untouched too — the guard runs before the transaction.
    const refund = await prisma.refundPayment.findFirstOrThrow({ where: { returnId: ret.id } });
    expect(refund.quickbooksPaymentId).toBeNull();
    expect(refund.syncStatus).toBe('NOT_SYNCED');
  });

  it('45 — a successful worker run is what sets SYNCED, and it carries real metadata', async () => {
    await disconnectQuickBooks(tile);
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    const before = await prisma.return.findUniqueOrThrow({ where: { id: ret.id } });
    expect(before.syncStatus).toBe('PENDING');
    expect(before.quickbooksDocumentId).toBeNull();

    await returnsSync.syncReturn(tile.tenantId, ret.id);

    const after = await prisma.return.findUniqueOrThrow({ where: { id: ret.id } });
    expect(after.syncStatus).toBe('SYNCED');
    expect(after.quickbooksDocumentId).toBeTruthy();
    const refund = await prisma.refundPayment.findFirstOrThrow({ where: { returnId: ret.id } });
    expect(refund.quickbooksPaymentId).toBe(after.quickbooksDocumentId);
  });

  it('45 — completing a return locally never marks it synced', async () => {
    const sale = await paidSale(tile, owner);
    const ret = await returnOneUnit(tile, owner, sale.id);

    expect(ret.syncStatus).not.toBe('SYNCED');
    expect(ret.quickbooksDocumentId).toBeNull();
    expect(ret.refundPayments[0].syncStatus).toBe('NOT_SYNCED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 46-51 — scope control
// ─────────────────────────────────────────────────────────────────────────────

describe('46-49 — Slice 6B changed nothing outside return accounting', () => {
  it('48 — the sale inventory decrement is unchanged', async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });
    await paidSale(tile, owner, 3);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });

    expect(Number(after.quantityOnHand)).toBe(Number(before.quantityOnHand) - 3);
  });

  it('48 — overselling is still refused by the same conditional update', async () => {
    await expect(
      sales.complete(tile.tenantId, owner, {
        branchId: tile.branchId,
        items: [{ productId: tile.productAId, quantity: 100_000 }],
        payments: [{ method: 'CASH', amount: 100_000_000 }],
      }),
    ).rejects.toThrow(/Insufficient stock/);
  });

  it('47 — a NONE tenant’s products are untouched by accounting adoption', async () => {
    await giveProfile(tile, AccountingProviderKind.NONE);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });

    expect(product.quickbooksItemId).not.toBeUndefined();
    // Product sync is Slice 6C+; nothing here writes to it.
    expect(await prisma.syncJob.count({ where: { entityType: 'PRODUCT' } })).toBe(0);
  });

  it('a NONE return still rolls the sale status up exactly as a QuickBooks one does', async () => {
    await giveProfile(tile, AccountingProviderKind.NONE);
    const sale = await paidSale(tile, owner, 1);
    const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });

    await returns.complete(
      tile.tenantId,
      owner,
      dto(CreateReturnDto, {
        originalSaleId: sale.id,
        refundMethod: 'CASH',
        approvalToken: await managerApproval(tile, sale.id, 1000),
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

    const row = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(row.returnStatus).toBe('FULLY_RETURNED');
    expect(row.status).toBe('REFUNDED');
    expect(Number(row.returnedAmount)).toBe(1000);
  });

  it('idempotency still returns the original return rather than creating a second', async () => {
    await giveProfile(tile, AccountingProviderKind.NONE);
    const sale = await paidSale(tile, owner);

    const first = await returnOneUnit(tile, owner, sale.id, { idempotencyKey: 'k-1' });
    const second = await returnOneUnit(tile, owner, sale.id, { idempotencyKey: 'k-1' });

    expect(second.id).toBe(first.id);
    expect(await prisma.return.count()).toBe(1);
    expect(await syncRowsFor(first.id)).toEqual([0, 0]);
  });
});
