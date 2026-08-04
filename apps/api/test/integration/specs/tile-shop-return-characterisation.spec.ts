/**
 * CHARACTERISATION — Tile Shop return / refund pipeline, as it behaves TODAY.
 *
 * Written against unmodified production code and proven green there BEFORE any
 * Phase 1 refactor, for the same reason as the sale characterisation spec.
 *
 * Phase 1 Slice 6 moves the restock behind `InventoryProvider.restoreStock` and
 * the QuickBooks push behind `AccountingProvider.postRefund`. Every assertion
 * below must still pass, UNEDITED, afterwards.
 *
 * Deliberately pinned here:
 *   • eager local restock ONLY for GOOD + RETURN_TO_STOCK + Inventory-type
 *   • server-recomputed proportional discount / tax reversal
 *   • the per-sale and per-line SaleReturnStatus roll-up, and Sale.status →
 *     REFUNDED on a full return
 *   • exactly ONE SyncJob per completed return (the transactional outbox)
 *   • the idempotency key preventing a double-submitted return
 */

import type { ItemCondition, PrismaClient, StockDisposition } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { dto } from '../dto';
import { MANAGER_PIN, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createIntegrationApp, type IntegrationApp } from '../test-app';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';
import { ApproveReturnDto } from '../../../src/modules/returns/dto/approve-return.dto';
import { CreateReturnDto } from '../../../src/modules/returns/dto/create-return.dto';
import type { SaleWithRelations } from '../../../src/modules/sales/sales.repository';

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

/** A completed, fully-paid sale of `quantity` × Product A (1000.00 each). */
async function paidSaleOfA(quantity = 2): Promise<SaleWithRelations> {
  return app.salesService.complete(tenant.tenantId, owner, {
    branchId: tenant.branchId,
    registerId: tenant.registerId,
    items: [{ productId: tenant.productAId, quantity }],
    payments: [{ method: 'CASH', amount: 1000 * quantity }],
  });
}

async function onHand(productId: string): Promise<number> {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  return Number(product.quantityOnHand);
}

/** Clear the sync jobs the sale itself created, so return assertions are unambiguous. */
async function clearSyncJobs(): Promise<void> {
  await prisma.syncLog.deleteMany({ where: { tenantId: tenant.tenantId } });
  await prisma.syncJob.deleteMany({ where: { tenantId: tenant.tenantId } });
}

function returnDto(overrides: Partial<CreateReturnDto> & { originalSaleId: string; items: unknown[] }) {
  return dto(CreateReturnDto, { refundMethod: 'CASH', ...overrides });
}

/**
 * Mint a manager approval token.
 *
 * Several perfectly ordinary returns require one — a full-sale return, any
 * non-GOOD item condition, a credit customer, or a refund method the sale was not
 * paid with. That rule set is itself pinned in the "approval requirements" block
 * below; this helper just lets the other specs get past it.
 */
async function managerApproval(saleId: string, refundTotal: number): Promise<string> {
  const result = await app.returnsService.approve(
    tenant.tenantId,
    dto(ApproveReturnDto, { managerPin: MANAGER_PIN, originalSaleId: saleId, refundTotal }),
  );
  if (!result.approved || !result.approvalToken) {
    throw new Error(`Fixture manager approval was refused: ${result.reason ?? 'unknown reason'}`);
  }
  return result.approvalToken;
}

// ─────────────────────────────────────────────────────────────────────────────
// Money
// ─────────────────────────────────────────────────────────────────────────────

describe('refund totals', () => {
  it('recomputes the refund from the original sale snapshot', async () => {
    const sale = await paidSaleOfA(2);
    await clearSyncJobs();

    const created = await app.returnsService.complete(
      tenant.tenantId,
      owner,
      returnDto({
        originalSaleId: sale.id,
        items: [
          {
            saleItemId: sale.items[0].id,
            returnQuantity: 1,
            returnReason: 'CHANGED_MIND',
            itemCondition: 'GOOD',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
      }),
      null,
    );

    expect(created.status).toBe('COMPLETED');
    expect(Number(created.refundTotal)).toBe(1000);
    expect(Number(created.subtotal)).toBe(1000);
    expect(created.refundMethod).toBe('CASH');
    expect(created.refundStatus).toBe('COMPLETED');
    expect(created.returnNumber).toBe('R-000001');
  });

  it('records a RefundPayment for the refunded amount', async () => {
    // Partial return (1 of 2): a FULL return would need manager approval.
    const sale = await paidSaleOfA(2);
    const created = await app.returnsService.complete(
      tenant.tenantId,
      owner,
      returnDto({
        originalSaleId: sale.id,
        items: [
          {
            saleItemId: sale.items[0].id,
            returnQuantity: 1,
            returnReason: 'CHANGED_MIND',
            itemCondition: 'GOOD',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
      }),
      null,
    );

    const refunds = await prisma.refundPayment.findMany({ where: { returnId: created.id } });
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0].amount)).toBe(1000);
    expect(refunds[0].method).toBe('CASH');
    expect(refunds[0].syncStatus).toBe('NOT_SYNCED');
  });

  it('reverses an order-level discount proportionally', async () => {
    // 2 × 1000 = 2000, less a 10% order discount = 1800 total.
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: [{ productId: tenant.productAId, quantity: 2 }],
      orderDiscountType: 'PERCENTAGE',
      orderDiscountValue: 10,
      payments: [{ method: 'CASH', amount: 1800 }],
    });
    expect(Number(sale.total)).toBe(1800);

    const created = await app.returnsService.complete(
      tenant.tenantId,
      owner,
      returnDto({
        originalSaleId: sale.id,
        items: [
          {
            saleItemId: sale.items[0].id,
            returnQuantity: 1,
            returnReason: 'CHANGED_MIND',
            itemCondition: 'GOOD',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
      }),
      null,
    );

    // Half the line returned ⇒ half the discount reversed: 1000 − 100 = 900.
    expect(Number(created.orderDiscountAdjustment)).toBe(100);
    expect(Number(created.refundTotal)).toBe(900);
  });

  it('rejects a return against a sale that is not COMPLETED', async () => {
    const draft = await app.salesService.createDraft(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: [{ productId: tenant.productAId, quantity: 1 }],
    });

    await expect(
      app.returnsService.complete(
        tenant.tenantId,
        owner,
        returnDto({
          originalSaleId: draft.id,
          items: [
            {
              saleItemId: draft.items[0].id,
              returnQuantity: 1,
              returnReason: 'CHANGED_MIND',
              itemCondition: 'GOOD',
              stockDisposition: 'RETURN_TO_STOCK',
            },
          ],
        }),
        null,
      ),
    ).rejects.toThrow('Returns can only be created against a completed sale');
  });

  it('rejects returning more than was purchased', async () => {
    const sale = await paidSaleOfA(1);

    await expect(
      app.returnsService.complete(
        tenant.tenantId,
        owner,
        returnDto({
          originalSaleId: sale.id,
          items: [
            {
              saleItemId: sale.items[0].id,
              returnQuantity: 5,
              returnReason: 'CHANGED_MIND',
              itemCondition: 'GOOD',
              stockDisposition: 'RETURN_TO_STOCK',
            },
          ],
        }),
        null,
      ),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Restock — the behaviour InventoryProvider.restoreStock must reproduce exactly
// ─────────────────────────────────────────────────────────────────────────────

describe('eager local restock', () => {
  /**
   * Return 1 unit in the given condition. A non-GOOD condition trips the
   * `requireApprovalForNonGoodCondition` rule, so a token is attached whenever the
   * condition is not GOOD — the approval rule itself is pinned separately below.
   */
  async function completeReturnWith(
    sale: SaleWithRelations,
    itemCondition: ItemCondition,
    stockDisposition: StockDisposition,
  ) {
    const unitPrice = Number(sale.items[0].unitPrice);
    const approvalToken =
      itemCondition === 'GOOD' ? undefined : await managerApproval(sale.id, unitPrice);

    return app.returnsService.complete(
      tenant.tenantId,
      owner,
      returnDto({
        originalSaleId: sale.id,
        approvalToken,
        items: [
          {
            saleItemId: sale.items[0].id,
            returnQuantity: 1,
            returnReason: 'CHANGED_MIND',
            itemCondition,
            stockDisposition,
          },
        ],
      }),
      null,
    );
  }

  it('restocks a GOOD item marked RETURN_TO_STOCK', async () => {
    const sale = await paidSaleOfA(2);
    await expect(onHand(tenant.productAId)).resolves.toBe(98);

    await completeReturnWith(sale, 'GOOD', 'RETURN_TO_STOCK');

    await expect(onHand(tenant.productAId)).resolves.toBe(99);
  });

  it('does NOT restock a GOOD item marked DO_NOT_RESTOCK', async () => {
    const sale = await paidSaleOfA(2);
    await completeReturnWith(sale, 'GOOD', 'DO_NOT_RESTOCK');
    await expect(onHand(tenant.productAId)).resolves.toBe(98);
  });

  it('does NOT restock a DAMAGED item', async () => {
    const sale = await paidSaleOfA(2);
    await completeReturnWith(sale, 'DAMAGED', 'DAMAGED_STOCK');
    await expect(onHand(tenant.productAId)).resolves.toBe(98);
  });

  it('does NOT restock a DEFECTIVE item sent for supplier review', async () => {
    const sale = await paidSaleOfA(2);
    await completeReturnWith(sale, 'DEFECTIVE', 'SUPPLIER_REVIEW');
    await expect(onHand(tenant.productAId)).resolves.toBe(98);
  });

  it('never moves stock for a non-inventory (Service) product', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      items: [{ productId: tenant.serviceProductId, quantity: 2 }],
      payments: [{ method: 'CASH', amount: 1000 }],
    });
    await completeReturnWith(sale, 'GOOD', 'RETURN_TO_STOCK');
    await expect(onHand(tenant.serviceProductId)).resolves.toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Approval requirements — discovered while writing this spec, so pinned here.
// These are real guard rails a Slice 6 refactor must not relax.
// ─────────────────────────────────────────────────────────────────────────────

describe('manager approval requirements', () => {
  function oneUnitBack(sale: SaleWithRelations, overrides: Record<string, unknown> = {}) {
    return returnDto({
      originalSaleId: sale.id,
      items: [
        {
          saleItemId: sale.items[0].id,
          returnQuantity: 1,
          returnReason: 'CHANGED_MIND',
          itemCondition: 'GOOD',
          stockDisposition: 'RETURN_TO_STOCK',
          ...overrides,
        },
      ],
    });
  }

  it('requires approval for a FULL-sale return', async () => {
    const sale = await paidSaleOfA(1);
    await expect(
      app.returnsService.complete(tenant.tenantId, owner, oneUnitBack(sale), null),
    ).rejects.toThrow('This return requires manager approval');
    // Nothing partially applied.
    await expect(prisma.return.count()).resolves.toBe(0);
    await expect(onHand(tenant.productAId)).resolves.toBe(99);
  });

  it('requires approval for a non-GOOD item condition', async () => {
    const sale = await paidSaleOfA(2);
    await expect(
      app.returnsService.complete(
        tenant.tenantId,
        owner,
        oneUnitBack(sale, { itemCondition: 'DAMAGED', stockDisposition: 'DAMAGED_STOCK' }),
        null,
      ),
    ).rejects.toThrow('This return requires manager approval');
  });

  it('requires approval when the customer is a credit customer', async () => {
    const sale = await app.salesService.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      customerId: tenant.creditCustomerId,
      items: [{ productId: tenant.productAId, quantity: 2 }],
      payments: [{ method: 'CASH', amount: 2000 }],
    });

    await expect(
      app.returnsService.complete(tenant.tenantId, owner, oneUnitBack(sale), null),
    ).rejects.toThrow('This return requires manager approval');
  });

  it('completes once a valid manager approval token is supplied', async () => {
    const sale = await paidSaleOfA(1);
    const approvalToken = await managerApproval(sale.id, 1000);

    const created = await app.returnsService.complete(
      tenant.tenantId,
      owner,
      returnDto({
        originalSaleId: sale.id,
        approvalToken,
        items: [
          {
            saleItemId: sale.items[0].id,
            returnQuantity: 1,
            returnReason: 'CHANGED_MIND',
            itemCondition: 'GOOD',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
      }),
      null,
    );

    expect(created.status).toBe('COMPLETED');
    expect(created.approvedByUserId).toBe(tenant.managerId);
  });

  it('refuses an approval attempt with an unknown PIN', async () => {
    const sale = await paidSaleOfA(1);
    await expect(
      app.returnsService.approve(
        tenant.tenantId,
        dto(ApproveReturnDto, {
          managerPin: '9999',
          originalSaleId: sale.id,
          refundTotal: 1000,
        }),
      ),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Return-status roll-up
// ─────────────────────────────────────────────────────────────────────────────

describe('return status roll-up', () => {
  it('marks a partially returned sale PARTIALLY_RETURNED', async () => {
    const sale = await paidSaleOfA(2);

    await app.returnsService.complete(
      tenant.tenantId,
      owner,
      returnDto({
        originalSaleId: sale.id,
        items: [
          {
            saleItemId: sale.items[0].id,
            returnQuantity: 1,
            returnReason: 'CHANGED_MIND',
            itemCondition: 'GOOD',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
      }),
      null,
    );

    const updated = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(updated.returnStatus).toBe('PARTIALLY_RETURNED');
    expect(updated.status).toBe('COMPLETED');
    expect(Number(updated.returnedAmount)).toBe(1000);

    const line = await prisma.saleItem.findUniqueOrThrow({ where: { id: sale.items[0].id } });
    expect(line.returnStatus).toBe('PARTIALLY_RETURNED');
    expect(Number(line.returnedQuantity)).toBe(1);
  });

  it('marks a fully returned sale FULLY_RETURNED and REFUNDED', async () => {
    const sale = await paidSaleOfA(2);
    // A full-sale return always requires manager approval (pinned above).
    const approvalToken = await managerApproval(sale.id, 2000);

    await app.returnsService.complete(
      tenant.tenantId,
      owner,
      returnDto({
        originalSaleId: sale.id,
        approvalToken,
        items: [
          {
            saleItemId: sale.items[0].id,
            returnQuantity: 2,
            returnReason: 'CHANGED_MIND',
            itemCondition: 'GOOD',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
      }),
      null,
    );

    const updated = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(updated.returnStatus).toBe('FULLY_RETURNED');
    // A fully-returned sale is reflected as REFUNDED for reporting parity.
    expect(updated.status).toBe('REFUNDED');
    expect(Number(updated.returnedAmount)).toBe(2000);
    await expect(onHand(tenant.productAId)).resolves.toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QuickBooks outbox — what AccountingProvider.postRefund must reproduce
// ─────────────────────────────────────────────────────────────────────────────

describe('QuickBooks sync outbox for returns', () => {
  it('enqueues exactly one RETURN_SYNC job inside the return transaction', async () => {
    const sale = await paidSaleOfA(2);
    await clearSyncJobs();

    const created = await app.returnsService.complete(
      tenant.tenantId,
      owner,
      returnDto({
        originalSaleId: sale.id,
        items: [
          {
            saleItemId: sale.items[0].id,
            returnQuantity: 1,
            returnReason: 'CHANGED_MIND',
            itemCondition: 'GOOD',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
      }),
      null,
    );

    const jobs = await prisma.syncJob.findMany({ where: { tenantId: tenant.tenantId } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: 'RETURN_SYNC',
      direction: 'OUTBOUND',
      entityType: 'RETURN',
      entityId: created.id,
      status: 'PENDING',
    });

    const logs = await prisma.syncLog.findMany({ where: { entityType: 'RETURN' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('Return queued for QuickBooks sync');
  });

  it('writes a return.completed audit record', async () => {
    const sale = await paidSaleOfA(2);

    const created = await app.returnsService.complete(
      tenant.tenantId,
      owner,
      returnDto({
        originalSaleId: sale.id,
        items: [
          {
            saleItemId: sale.items[0].id,
            returnQuantity: 1,
            returnReason: 'CHANGED_MIND',
            itemCondition: 'GOOD',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
      }),
      null,
    );

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: tenant.tenantId, action: 'return.completed' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(created.id);
    expect(audits[0].userId).toBe(tenant.ownerId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency (the pattern restaurant order rounds will reuse)
// ─────────────────────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('returns the original return for a replayed idempotency key', async () => {
    const sale = await paidSaleOfA(2);
    const body = returnDto({
      originalSaleId: sale.id,
      idempotencyKey: 'replay-me',
      items: [
        {
          saleItemId: sale.items[0].id,
          returnQuantity: 1,
          returnReason: 'CHANGED_MIND',
          itemCondition: 'GOOD',
          stockDisposition: 'RETURN_TO_STOCK',
        },
      ],
    });

    const first = await app.returnsService.complete(tenant.tenantId, owner, body, null);
    const second = await app.returnsService.complete(tenant.tenantId, owner, body, null);

    expect(second.id).toBe(first.id);
    await expect(prisma.return.count({ where: { tenantId: tenant.tenantId } })).resolves.toBe(1);
    // Critically: the replay must not restock a second time.
    await expect(onHand(tenant.productAId)).resolves.toBe(99);
  });

  it('accepts the idempotency key from the header argument too', async () => {
    const sale = await paidSaleOfA(2);
    const body = returnDto({
      originalSaleId: sale.id,
      items: [
        {
          saleItemId: sale.items[0].id,
          returnQuantity: 1,
          returnReason: 'CHANGED_MIND',
          itemCondition: 'GOOD',
          stockDisposition: 'RETURN_TO_STOCK',
        },
      ],
    });

    const first = await app.returnsService.complete(tenant.tenantId, owner, body, 'header-key');
    const second = await app.returnsService.complete(tenant.tenantId, owner, body, 'header-key');

    expect(second.id).toBe(first.id);
    await expect(prisma.return.count({ where: { tenantId: tenant.tenantId } })).resolves.toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenant isolation (decision D17)
// ─────────────────────────────────────────────────────────────────────────────

describe('tenant scoping of the return pipeline', () => {
  it('refuses to return against another tenant’s sale', async () => {
    const sale = await paidSaleOfA(1);
    const other = await prisma.tenant.create({
      data: { id: 'other-tenant', name: 'Other', slug: 'other' },
    });

    await expect(
      app.returnsService.complete(
        other.id,
        { id: 'ghost', tenantId: other.id, role: 'OWNER' },
        returnDto({
          originalSaleId: sale.id,
          items: [
            {
              saleItemId: sale.items[0].id,
              returnQuantity: 1,
              returnReason: 'CHANGED_MIND',
              itemCondition: 'GOOD',
              stockDisposition: 'RETURN_TO_STOCK',
            },
          ],
        }),
        null,
      ),
    ).rejects.toThrow();

    await expect(prisma.return.count()).resolves.toBe(0);
  });
});
