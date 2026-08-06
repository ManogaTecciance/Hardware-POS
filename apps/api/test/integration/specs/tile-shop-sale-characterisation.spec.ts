/**
 * CHARACTERISATION — Tile Shop sale pipeline, as it behaves TODAY.
 *
 * These assertions were written against unmodified production code and proven
 * green there BEFORE any Phase 1 refactor. That ordering is the whole point: a
 * spec written after a refactor documents the new behaviour, not the old, and is
 * worthless as a regression baseline.
 *
 * Phase 1 Slice 6 moves the QuickBooks decisions out of `sales.service` and the
 * stock/outbox writes behind `InventoryProvider` / `AccountingProvider`. Every
 * assertion below must still pass, UNEDITED, afterwards. If one has to change,
 * the refactor is not backward-compatible and must be redesigned.
 *
 * Deliberately pinned here:
 *   • paid ⇒ SALES_RECEIPT, partial/credit ⇒ INVOICE  (a QuickBooks concept
 *     currently decided inside the core sale pipeline)
 *   • exactly ONE SyncJob per completed sale (the transactional outbox)
 *   • local stock decrement inside the sale transaction, and the conditional
 *     `gte` guard that makes overselling impossible under concurrency
 *   • the exact user-facing error messages, which the UI surfaces verbatim
 */

import { BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { dto } from '../dto';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createIntegrationApp, type IntegrationApp } from '../test-app';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';
import { QuerySalesDto } from '../../../src/modules/sales/dto/query-sales.dto';

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
  owner = { id: tenant.ownerId, tenantId: tenant.tenantId, role: 'OWNER' , activeBranchId: null };
});

/** Line totalling 1000.00 (1 × Product A). */
function oneUnitOfA() {
  return [{ productId: tenant.productAId, quantity: 1 }];
}

async function onHand(productId: string): Promise<number> {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  return Number(product.quantityOnHand);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fully paid sale
// ─────────────────────────────────────────────────────────────────────────────

describe('fully paid sale', () => {
  it('completes as PAID and maps to a QuickBooks SALES_RECEIPT', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      registerId: tenant.registerId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 1000 }],
    });

    expect(sale.status).toBe('COMPLETED');
    expect(sale.paymentStatus).toBe('PAID');
    expect(Number(sale.subtotal)).toBe(1000);
    expect(Number(sale.total)).toBe(1000);
    expect(Number(sale.paidAmount)).toBe(1000);
    expect(Number(sale.balanceAmount)).toBe(0);
    // The QuickBooks document type is currently decided inside sales.service.
    expect(sale.quickbooksDocumentType).toBe('SALES_RECEIPT');
    expect(sale.completedAt).not.toBeNull();
  });

  it('numbers sales from the DocumentSequence counter', async () => {
    const first = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 1000 }],
    });
    const second = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 1000 }],
    });

    expect(first.saleNumber).toBe('S-000001');
    expect(second.saleNumber).toBe('S-000002');

    const sequence = await prisma.documentSequence.findUniqueOrThrow({
      where: { tenantId_docType: { tenantId: tenant.tenantId, docType: 'SALE' } },
    });
    expect(sequence.value).toBe(2);
  });

  it('persists the payment against the sale', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 1000, reference: 'drawer-1' }],
    });

    const payments = await prisma.payment.findMany({ where: { saleId: sale.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0].method).toBe('CASH');
    expect(Number(payments[0].amount)).toBe(1000);
    expect(payments[0].reference).toBe('drawer-1');
    expect(payments[0].syncStatus).toBe('NOT_SYNCED');
    expect(payments[0].quickbooksPaymentId).toBeNull();
  });

  it('supports mixed payment methods totalling the sale', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: oneUnitOfA(),
      payments: [
        { method: 'CASH', amount: 400 },
        { method: 'CARD', amount: 350 },
        { method: 'QR_PAYMENT', amount: 250 },
      ],
    });

    expect(sale.paymentStatus).toBe('PAID');
    expect(Number(sale.paidAmount)).toBe(1000);
    expect(sale.quickbooksDocumentType).toBe('SALES_RECEIPT');
    await expect(prisma.payment.count({ where: { saleId: sale.id } })).resolves.toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credit / partial sale
// ─────────────────────────────────────────────────────────────────────────────

describe('credit and partial sales', () => {
  it('maps a partial payment to a QuickBooks INVOICE and leaves a balance', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      customerId: tenant.creditCustomerId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 400 }],
    });

    expect(sale.paymentStatus).toBe('PARTIAL');
    expect(Number(sale.paidAmount)).toBe(400);
    expect(Number(sale.balanceAmount)).toBe(600);
    expect(sale.quickbooksDocumentType).toBe('INVOICE');
  });

  it('maps a fully unpaid credit sale to an INVOICE', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      customerId: tenant.creditCustomerId,
      items: oneUnitOfA(),
      payments: [],
    });

    expect(sale.paymentStatus).toBe('UNPAID');
    expect(Number(sale.balanceAmount)).toBe(1000);
    expect(sale.quickbooksDocumentType).toBe('INVOICE');
  });

  /**
   * This constraint exists ONLY because a QuickBooks Invoice requires a
   * CustomerRef. Pinned deliberately: Slice 6 moves it behind the QuickBooks
   * accounting provider, and assertion R10 of the Phase 1 plan then proves a
   * tenant with NO accounting provider is no longer bound by it.
   */
  it('rejects a credit sale with no customer (a QuickBooks Invoice constraint)', async () => {
    await expect(
      app.salesService.complete(tenant.tenantId, owner, {
        branchId: tenant.branchId,
        items: oneUnitOfA(),
        payments: [{ method: 'CASH', amount: 400 }],
      }),
    ).rejects.toThrow('A customer is required for a credit/partial sale (Invoice)');
  });

  it('rejects a credit sale for a customer not approved for credit', async () => {
    await expect(
      app.salesService.complete(tenant.tenantId, owner, {
        branchId: tenant.branchId,
        customerId: tenant.cashOnlyCustomerId,
        items: oneUnitOfA(),
        payments: [{ method: 'CASH', amount: 400 }],
      }),
    ).rejects.toThrow(
      'This customer is not approved for credit. Take full payment to complete the sale.',
    );
  });

  it('enforces the credit limit across the customer’s existing outstanding balance', async () => {
    // Limit is 50 000. Product A is 1000/unit, so 45 units leaves 45 000 outstanding.
    await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      customerId: tenant.creditCustomerId,
      items: [{ productId: tenant.productAId, quantity: 45 }],
      payments: [],
    });

    // A further 10 000 of credit would reach 55 000 — over the limit.
    await expect(
      app.salesService.complete(tenant.tenantId, owner, {
        branchId: tenant.branchId,
        customerId: tenant.creditCustomerId,
        items: [{ productId: tenant.productAId, quantity: 10 }],
        payments: [],
      }),
    ).rejects.toThrow(/Credit limit exceeded/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inventory — the behaviour LocalInventoryProvider must reproduce exactly
// ─────────────────────────────────────────────────────────────────────────────

describe('local stock movement', () => {
  it('decrements on-hand stock for an inventory product', async () => {
    await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: [{ productId: tenant.productAId, quantity: 3 }],
      payments: [{ method: 'CASH', amount: 3000 }],
    });

    await expect(onHand(tenant.productAId)).resolves.toBe(97);
  });

  it('never moves stock for a non-inventory (Service) product', async () => {
    await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: [{ productId: tenant.serviceProductId, quantity: 4 }],
      payments: [{ method: 'CASH', amount: 2000 }],
    });

    await expect(onHand(tenant.serviceProductId)).resolves.toBe(0);
  });

  it('aggregates repeated lines for the same product into one decrement', async () => {
    await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: [
        { productId: tenant.productAId, quantity: 2 },
        { productId: tenant.productAId, quantity: 5 },
      ],
      payments: [{ method: 'CASH', amount: 7000 }],
    });

    await expect(onHand(tenant.productAId)).resolves.toBe(93);
  });

  it('rejects a cart that exceeds on-hand stock', async () => {
    await expect(
      app.salesService.complete(tenant.tenantId, owner, {
        branchId: tenant.branchId,
        items: [{ productId: tenant.productAId, quantity: 101 }],
        payments: [{ method: 'CASH', amount: 101_000 }],
      }),
    ).rejects.toThrow(/Insufficient stock for Fixture Product A/);

    await expect(onHand(tenant.productAId)).resolves.toBe(100);
  });

  it('writes nothing at all when the sale is rejected', async () => {
    await expect(
      app.salesService.complete(tenant.tenantId, owner, {
        branchId: tenant.branchId,
        items: [{ productId: tenant.productAId, quantity: 500 }],
        payments: [{ method: 'CASH', amount: 500_000 }],
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(prisma.sale.count({ where: { tenantId: tenant.tenantId } })).resolves.toBe(0);
    await expect(prisma.syncJob.count({ where: { tenantId: tenant.tenantId } })).resolves.toBe(0);
  });

  /**
   * The authoritative oversell guard. `decrementStock` uses a conditional
   * `updateMany({ where: { quantityOnHand: { gte: qty } } })` and treats a
   * zero-row result as fatal, so of two concurrent carts that each fit alone but
   * not together, exactly one can win. This is the property Slice 6 must not lose
   * by moving the write outside the transaction.
   */
  it('lets only one of two concurrent oversold carts succeed', async () => {
    // 50 on hand of Product B; two carts of 40 each.
    const cart = () =>
      app.salesService.complete(tenant.tenantId, owner, {
        branchId: tenant.branchId,
        items: [{ productId: tenant.productBId, quantity: 40 }],
        payments: [{ method: 'CASH', amount: 10_020 }],
      });

    const results = await Promise.allSettled([cart(), cart()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    await expect(onHand(tenant.productBId)).resolves.toBe(10);
    await expect(prisma.sale.count({ where: { tenantId: tenant.tenantId } })).resolves.toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QuickBooks outbox — what AccountingProvider.postSale must reproduce
// ─────────────────────────────────────────────────────────────────────────────

describe('QuickBooks sync outbox', () => {
  it('enqueues exactly one SyncJob per completed sale, inside the sale transaction', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 1000 }],
    });

    const jobs = await prisma.syncJob.findMany({ where: { tenantId: tenant.tenantId } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: 'SALES_SYNC',
      direction: 'OUTBOUND',
      entityType: 'SALE',
      entityId: sale.id,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 5,
    });
    // The sale itself is marked pending-sync, not synced.
    expect(sale.syncStatus).toBe('PENDING');
    expect(sale.quickbooksDocumentId).toBeNull();
  });

  it('writes the matching SyncLog entry', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 1000 }],
    });

    const logs = await prisma.syncLog.findMany({ where: { tenantId: tenant.tenantId } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      entityType: 'SALE',
      entityId: sale.id,
      direction: 'OUTBOUND',
      status: 'PENDING',
      message: 'Sale queued for QuickBooks sync',
    });
  });

  it('enqueues one job per sale and no more', async () => {
    for (let i = 0; i < 3; i += 1) {
      await app.salesService.complete(tenant.tenantId, owner, {
        branchId: tenant.branchId,
        items: oneUnitOfA(),
        payments: [{ method: 'CASH', amount: 1000 }],
      });
    }
    await expect(prisma.syncJob.count({ where: { tenantId: tenant.tenantId } })).resolves.toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Server-authoritative pricing
// ─────────────────────────────────────────────────────────────────────────────

describe('server-authoritative pricing', () => {
  it('rejects a client-supplied unit price that no longer matches the catalogue', async () => {
    await expect(
      app.salesService.complete(tenant.tenantId, owner, {
        branchId: tenant.branchId,
        items: [{ productId: tenant.productAId, quantity: 1, unitPrice: 1 }],
        payments: [{ method: 'CASH', amount: 1 }],
      }),
    ).rejects.toThrow('Price for Fixture Product A has changed; refresh the product cache');
  });

  it('accepts a client-supplied unit price that matches', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: [{ productId: tenant.productAId, quantity: 1, unitPrice: 1000 }],
      payments: [{ method: 'CASH', amount: 1000 }],
    });
    expect(Number(sale.total)).toBe(1000);
  });

  it('ignores a client-supplied total and recomputes from the catalogue', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: [{ productId: tenant.productBId, quantity: 4 }],
      payments: [{ method: 'CASH', amount: 1002 }],
    });
    // 4 × 250.50 — proves the Decimal(12,2) arithmetic, not a rounded float.
    expect(Number(sale.subtotal)).toBe(1002);
    expect(Number(sale.total)).toBe(1002);
  });

  it('rejects an inactive product', async () => {
    await prisma.product.update({
      where: { id: tenant.productAId },
      data: { isActive: false },
    });

    await expect(
      app.salesService.complete(tenant.tenantId, owner, {
        branchId: tenant.branchId,
        items: oneUnitOfA(),
        payments: [{ method: 'CASH', amount: 1000 }],
      }),
    ).rejects.toThrow('Product Fixture Product A is inactive');
  });

  it('rejects an empty cart', async () => {
    await expect(
      app.salesService.complete(tenant.tenantId, owner, {
        branchId: tenant.branchId,
        items: [],
        payments: [],
      }),
    ).rejects.toThrow('Cart is empty');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Drafts
// ─────────────────────────────────────────────────────────────────────────────

describe('draft sales', () => {
  it('creates a DRAFT that moves no stock and enqueues no sync job', async () => {
    const draft = await app.salesService.createDraft(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: [{ productId: tenant.productAId, quantity: 2 }],
    });

    expect(draft.status).toBe('DRAFT');
    expect(draft.syncStatus).toBe('NOT_SYNCED');
    expect(Number(draft.balanceAmount)).toBe(2000);
    await expect(onHand(tenant.productAId)).resolves.toBe(100);
    await expect(prisma.syncJob.count({ where: { tenantId: tenant.tenantId } })).resolves.toBe(0);
  });

  it('completing a draft decrements stock and enqueues exactly one sync job', async () => {
    const draft = await app.salesService.createDraft(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: [{ productId: tenant.productAId, quantity: 2 }],
    });

    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      saleId: draft.id,
      payments: [{ method: 'CASH', amount: 2000 }],
    });

    expect(sale.id).toBe(draft.id);
    expect(sale.status).toBe('COMPLETED');
    expect(sale.quickbooksDocumentType).toBe('SALES_RECEIPT');
    await expect(onHand(tenant.productAId)).resolves.toBe(98);
    await expect(prisma.syncJob.count({ where: { tenantId: tenant.tenantId } })).resolves.toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenant isolation (decision D17)
// ─────────────────────────────────────────────────────────────────────────────

describe('tenant scoping of the sale pipeline', () => {
  it('refuses another tenant’s branch', async () => {
    const other = await prisma.tenant.create({
      data: { id: 'other-tenant', name: 'Other', slug: 'other' },
    });
    const otherBranch = await prisma.branch.create({
      data: { tenantId: other.id, name: 'Other Main', code: 'MAIN' },
    });

    await expect(
      app.salesService.complete(tenant.tenantId, owner, {
        branchId: otherBranch.id,
        items: oneUnitOfA(),
        payments: [{ method: 'CASH', amount: 1000 }],
      }),
    ).rejects.toThrow(`Unknown branch ${otherBranch.id}`);
  });

  it('refuses another tenant’s product', async () => {
    const other = await prisma.tenant.create({
      data: { id: 'other-tenant', name: 'Other', slug: 'other' },
    });
    const otherProduct = await prisma.product.create({
      data: {
        tenantId: other.id,
        name: 'Other Product',
        type: 'Inventory',
        unitPrice: '10.00',
        quantityOnHand: '5.000',
      },
    });

    await expect(
      app.salesService.complete(tenant.tenantId, owner, {
        branchId: tenant.branchId,
        items: [{ productId: otherProduct.id, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 10 }],
      }),
    ).rejects.toThrow(`Unknown product ${otherProduct.id}`);
  });

  it('refuses another tenant’s customer', async () => {
    const other = await prisma.tenant.create({
      data: { id: 'other-tenant', name: 'Other', slug: 'other' },
    });
    const otherCustomer = await prisma.customer.create({
      data: { tenantId: other.id, name: 'Other Customer', creditAllowed: true },
    });

    await expect(
      app.salesService.complete(tenant.tenantId, owner, {
        branchId: tenant.branchId,
        customerId: otherCustomer.id,
        items: oneUnitOfA(),
        payments: [{ method: 'CASH', amount: 1000 }],
      }),
    ).rejects.toThrow(`Unknown customer ${otherCustomer.id}`);
  });

  it('does not list another tenant’s sales', async () => {
    await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: oneUnitOfA(),
      payments: [{ method: 'CASH', amount: 1000 }],
    });

    const other = await prisma.tenant.create({
      data: { id: 'other-tenant', name: 'Other', slug: 'other' },
    });

    const query = dto(QuerySalesDto, { page: 1, pageSize: 20 });
    const mine = await app.salesService.list(tenant.tenantId, query);
    const theirs = await app.salesService.list(other.id, query);

    expect(mine.items).toHaveLength(1);
    expect(mine.total).toBe(1);
    expect(theirs.items).toHaveLength(0);
    expect(theirs.total).toBe(0);
  });
});
