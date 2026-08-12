/**
 * Unit tests for InventoryReceiptsService (D44).
 *
 * The Prisma client is fully mocked — every read the service does is stubbed
 * with the answers a well-formed tenant would produce, and every write is a
 * `jest.fn()` we assert on. The InventoryProviderFactory is stubbed to a
 * scriptable receiveStock spy so the service's per-line outcome plumbing is
 * asserted without pulling in the real weighted-average implementation.
 *
 * D30 compliance: every rejection test also asserts that `receiveStock` was
 * NOT called — a validation that runs AFTER the provider has already moved
 * stock would be worse than useless.
 */

import { BadRequestException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { InventoryProviderFactory } from '../providers/inventory/inventory-provider.factory';
import { ProductNotFoundInTenantError } from '../providers/provider.errors';
import { InventoryReceiptsRepository } from './inventory-receipts.repository';
import { InventoryReceiptsService } from './inventory-receipts.service';

// ── Helpers ────────────────────────────────────────────────────────────────

type AnyFn = (...args: unknown[]) => unknown;

/** A minimally-typed Jest mock that pretends to be a Prisma model delegate. */
function fnDefault<T>(value: T): jest.Mock {
  return jest.fn().mockResolvedValue(value);
}

interface PrismaHarness {
  prisma: PrismaService;
  transaction: jest.Mock;
  audit: { create: jest.Mock };
  branch: { findFirst: jest.Mock };
  supplier: { findFirst: jest.Mock };
  product: { findMany: jest.Mock; update: jest.Mock };
  productVariant: { findMany: jest.Mock; update: jest.Mock };
  inventoryReceipt: {
    create: jest.Mock;
    findFirst: jest.Mock;
  };
  inventoryReceiptLine: { create: jest.Mock };
  branchInventory: { findMany: jest.Mock };
  stockMovement: { findMany: jest.Mock };
  documentSequenceRaw: jest.Mock;
}

/**
 * Build a "tx" that shares almost everything with the outer client so both
 * pre-transaction reads AND in-transaction reads/writes reach the same spies.
 * Only $transaction and $queryRaw need special handling.
 */
function makeTxLike(base: PrismaHarness) {
  return {
    inventoryReceipt: base.inventoryReceipt,
    inventoryReceiptLine: base.inventoryReceiptLine,
    branchInventory: base.branchInventory,
    stockMovement: base.stockMovement,
    productVariant: base.productVariant,
    product: base.product,
    auditLog: base.audit,
    $queryRaw: base.documentSequenceRaw,
  } as never;
}

function makeHarness(overrides: Partial<PrismaHarness> = {}): PrismaHarness {
  const audit = { create: jest.fn().mockResolvedValue({}) };
  const branch = {
    findFirst: fnDefault({ id: 'br1', name: 'Main' }),
  };
  const supplier = { findFirst: fnDefault({ id: 'sup1' }) };
  const product = {
    findMany: fnDefault([{ id: 'p1', name: 'Widget', type: 'Inventory' }]),
    update: jest.fn().mockResolvedValue({}),
  };
  const productVariant = {
    findMany: fnDefault([{ id: 'v1', productId: 'p1' }]),
    update: jest.fn().mockResolvedValue({}),
  };
  // The in-memory "receipts" the harness has seen created. `findFirst` on the
  // receipt table synthesises a joinable row from this map so the service's
  // read-after-write path can complete without a real database.
  const createdReceipts: Map<string, Record<string, unknown>> = new Map();
  const createdLines: Map<string, Record<string, unknown>[]> = new Map();

  const inventoryReceipt = {
    create: jest.fn().mockImplementation(({ data }: { data: unknown }) => {
      const row = {
        id: 'rcpt1',
        receiptNumber:
          (data as { receiptNumber?: string }).receiptNumber ?? 'RCV-000001',
        createdAt: new Date(),
        receivedAt: new Date(),
        ...(data as Record<string, unknown>),
      };
      createdReceipts.set(row.id as string, row);
      createdLines.set(row.id as string, []);
      return Promise.resolve(row);
    }),
    findFirst: jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      const id = (where.id as string) ?? undefined;
      const key = (where.idempotencyKey as string) ?? undefined;
      let found: Record<string, unknown> | undefined;
      if (id) found = createdReceipts.get(id);
      if (!found && key) {
        for (const row of createdReceipts.values()) {
          if (row.idempotencyKey === key) {
            found = row;
            break;
          }
        }
      }
      if (!found) return Promise.resolve(null);
      // Enrich with the includes the service reads.
      return Promise.resolve({
        ...found,
        lines: createdLines.get(found.id as string) ?? [],
        supplier: found.supplierId ? { id: found.supplierId, name: 'S' } : null,
        branch: { id: found.branchId, name: 'Main' },
        createdBy: { id: found.createdByUserId, name: 'User' },
      });
    }),
  };
  const inventoryReceiptLine = {
    create: jest.fn().mockImplementation(({ data }: { data: unknown }) => {
      const payload = data as Record<string, unknown>;
      const row: Record<string, unknown> = {
        id: 'line-' + Math.random().toString(36).slice(2, 8),
        lotNumber: null,
        expiryDate: null,
        ...payload,
      };
      const receiptId = (payload.receiptId as string) ?? 'rcpt1';
      const bucket = createdLines.get(receiptId) ?? [];
      bucket.push(row);
      createdLines.set(receiptId, bucket);
      return Promise.resolve(row);
    }),
  };
  const branchInventory = { findMany: fnDefault([]) };
  const stockMovement = { findMany: fnDefault([]) };
  const documentSequenceRaw = jest.fn().mockResolvedValue([{ value: 42 }]);

  // Materialise `$transaction` so the callback receives the same tx-alike
  // client the service does in prod. `$queryRaw` on the base client hands off
  // to the same spy for symmetry with the inner tx.
  const harness = {
    audit,
    branch,
    supplier,
    product,
    productVariant,
    inventoryReceipt,
    inventoryReceiptLine,
    branchInventory,
    stockMovement,
    documentSequenceRaw,
    transaction: jest.fn(),
  } as unknown as PrismaHarness;
  Object.assign(harness, overrides);
  const tx = makeTxLike(harness);
  harness.transaction = jest.fn().mockImplementation((cb: AnyFn) => cb(tx));

  const prisma = {
    $transaction: harness.transaction,
    $queryRaw: documentSequenceRaw,
    auditLog: audit,
    branch,
    supplier,
    product,
    productVariant,
    inventoryReceipt,
    inventoryReceiptLine,
    branchInventory,
    stockMovement,
  } as unknown as PrismaService;
  harness.prisma = prisma;
  return harness;
}

function makeInventoryFactory(receiveStock: jest.Mock) {
  return {
    forTenant: jest.fn().mockResolvedValue({
      mode: 'LOCAL',
      name: 'Local inventory',
      receiveStock,
    }),
  } as unknown as InventoryProviderFactory;
}

function makeService(
  receiveStockImpl: (...args: unknown[]) => unknown = () => Promise.resolve([]),
  harnessOverrides: Partial<PrismaHarness> = {},
): {
  service: InventoryReceiptsService;
  harness: PrismaHarness;
  receiveStock: jest.Mock;
} {
  const harness = makeHarness(harnessOverrides);
  const repo = new InventoryReceiptsRepository(harness.prisma);
  const receiveStock = jest.fn().mockImplementation(receiveStockImpl);
  const inventory = makeInventoryFactory(receiveStock);
  const service = new InventoryReceiptsService(repo, harness.prisma, inventory);
  return { service, harness, receiveStock };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('InventoryReceiptsService.createReceipt — weighted-average', () => {
  it('1: first receipt on a variant with NULL average sets averageCostAfter to unitCost', async () => {
    const { service, harness, receiveStock } = makeService((tx, ctx, lines) =>
      Promise.resolve(
        (lines as { productId: string; productVariantId: string | null }[]).map((l) => ({
          productId: l.productId,
          productVariantId: l.productVariantId,
          quantityOnHandAfter: 100,
          averageCostAfter: 150, // provider is authoritative for the outcome
        })),
      ),
    );
    // Only ONE BranchInventory row after the receipt, holding the just-received qty+avg.
    harness.branchInventory.findMany.mockResolvedValue([
      { productId: 'p1', productVariantId: 'v1', quantityOnHand: 100, averageCost: 150 },
    ]);
    harness.stockMovement.findMany.mockResolvedValue([]);

    const result = await service.createReceipt('t1', 'user1', {
      branchId: 'br1',
      lines: [
        {
          productId: 'p1',
          productVariantId: 'v1',
          quantityReceived: 100,
          unitCost: 150,
        },
      ],
    });

    expect(receiveStock).toHaveBeenCalledTimes(1);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].averageCostAfter).toBe(150);
    // The variant mirror was refreshed with the tenant-wide weighted mean —
    // for a single branch that mean is just this branch's average.
    expect(harness.productVariant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'v1' },
        data: expect.objectContaining({ averageCost: 150, costPrice: 150 }),
      }),
    );
  });

  it('2: second receipt at a different unitCost recomputes weighted-average (20@150 + 100@160 → 158.3333)', async () => {
    const { service, harness, receiveStock } = makeService((_tx, _ctx, lines) =>
      Promise.resolve(
        (lines as { productId: string; productVariantId: string | null }[]).map((l) => ({
          productId: l.productId,
          productVariantId: l.productVariantId,
          quantityOnHandAfter: 120,
          averageCostAfter: (20 * 150 + 100 * 160) / 120,
        })),
      ),
    );
    // After the receipt, the single BranchInventory row holds 120 units at
    // the weighted mean. The service's tenant-wide roll-up must reproduce it.
    const expected = (20 * 150 + 100 * 160) / 120;
    harness.branchInventory.findMany.mockResolvedValue([
      {
        productId: 'p1',
        productVariantId: 'v1',
        quantityOnHand: 120,
        averageCost: expected,
      },
    ]);
    harness.stockMovement.findMany.mockResolvedValue([]);

    const result = await service.createReceipt('t1', 'user1', {
      branchId: 'br1',
      lines: [
        {
          productId: 'p1',
          productVariantId: 'v1',
          quantityReceived: 100,
          unitCost: 160,
        },
      ],
    });

    expect(receiveStock).toHaveBeenCalledTimes(1);
    expect(result.lines[0].averageCostAfter).toBeCloseTo(expected, 4);
    expect(Number(result.lines[0].averageCostAfter.toFixed(4))).toBe(158.3333);
    expect(harness.productVariant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'v1' },
        data: expect.objectContaining({
          averageCost: expect.closeTo(expected, 4) as unknown as number,
          costPrice: 160,
        }),
      }),
    );
  });
});

describe('InventoryReceiptsService.createReceipt — idempotency', () => {
  it('3: the same idempotencyKey twice returns the same receipt and only calls receiveStock once', async () => {
    const { service, harness, receiveStock } = makeService((_tx, _ctx, lines) =>
      Promise.resolve(
        (lines as { productId: string; productVariantId: string | null }[]).map((l) => ({
          productId: l.productId,
          productVariantId: l.productVariantId,
          quantityOnHandAfter: 10,
          averageCostAfter: 100,
        })),
      ),
    );
    harness.branchInventory.findMany.mockResolvedValue([
      { productId: 'p1', productVariantId: 'v1', quantityOnHand: 10, averageCost: 100 },
    ]);

    // First call: nothing exists yet → the write path runs; the harness's
    // in-memory `createdReceipts` map records the row so the SECOND call's
    // idempotency lookup finds it without needing another `mockResolvedValueOnce`.
    const first = await service.createReceipt('t1', 'user1', {
      branchId: 'br1',
      idempotencyKey: 'op-42',
      lines: [
        {
          productId: 'p1',
          productVariantId: 'v1',
          quantityReceived: 10,
          unitCost: 100,
        },
      ],
    });

    // Second call: the same key resolves to the stored receipt → the write
    // path is skipped and the provider is NOT called.
    const second = await service.createReceipt('t1', 'user1', {
      branchId: 'br1',
      idempotencyKey: 'op-42',
      lines: [
        {
          productId: 'p1',
          productVariantId: 'v1',
          quantityReceived: 10,
          unitCost: 100,
        },
      ],
    });

    expect(second.id).toBe(first.id);
    expect(receiveStock).toHaveBeenCalledTimes(1);
  });
});

describe('InventoryReceiptsService.createReceipt — validation runs BEFORE the provider', () => {
  it('4: negative unitCost is rejected and receiveStock is never called', async () => {
    const { service, receiveStock } = makeService();
    await expect(
      service.createReceipt('t1', 'u1', {
        branchId: 'br1',
        lines: [
          { productId: 'p1', productVariantId: 'v1', quantityReceived: 10, unitCost: -1 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(receiveStock).not.toHaveBeenCalled();
  });

  it('5: zero or negative quantity is rejected and receiveStock is never called', async () => {
    const { service, receiveStock } = makeService();
    for (const bad of [0, -1]) {
      await expect(
        service.createReceipt('t1', 'u1', {
          branchId: 'br1',
          lines: [
            { productId: 'p1', productVariantId: 'v1', quantityReceived: bad, unitCost: 5 },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(receiveStock).not.toHaveBeenCalled();
  });

  it('6: a productId not belonging to this tenant is rejected as ProductNotFoundInTenantError', async () => {
    const { service, harness, receiveStock } = makeService();
    // `assertProductsAndVariants` returns an empty map when no product matches.
    harness.product.findMany.mockResolvedValueOnce([]);
    await expect(
      service.createReceipt('t1', 'u1', {
        branchId: 'br1',
        lines: [
          {
            productId: 'p-other-tenant',
            quantityReceived: 5,
            unitCost: 100,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ProductNotFoundInTenantError);
    expect(receiveStock).not.toHaveBeenCalled();
  });

  it('7: a variantId belonging to a different product is rejected and receiveStock is never called', async () => {
    const { service, harness, receiveStock } = makeService();
    // The variant exists but its parent product does not match.
    harness.productVariant.findMany.mockResolvedValueOnce([
      { id: 'v-elsewhere', productId: 'p2' },
    ]);
    await expect(
      service.createReceipt('t1', 'u1', {
        branchId: 'br1',
        lines: [
          {
            productId: 'p1',
            productVariantId: 'v-elsewhere',
            quantityReceived: 5,
            unitCost: 100,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(receiveStock).not.toHaveBeenCalled();
  });
});

describe('InventoryReceiptsService.createReceipt — audit', () => {
  it('8: writes ONE AuditLog row inside the transaction with action INVENTORY_RECEIVED', async () => {
    const { service, harness } = makeService((_tx, _ctx, lines) =>
      Promise.resolve(
        (lines as { productId: string; productVariantId: string | null }[]).map((l) => ({
          productId: l.productId,
          productVariantId: l.productVariantId,
          quantityOnHandAfter: 3,
          averageCostAfter: 25,
        })),
      ),
    );
    harness.branchInventory.findMany.mockResolvedValue([
      { productId: 'p1', productVariantId: 'v1', quantityOnHand: 3, averageCost: 25 },
    ]);
    await service.createReceipt('t1', 'user1', {
      branchId: 'br1',
      lines: [
        { productId: 'p1', productVariantId: 'v1', quantityReceived: 3, unitCost: 25 },
      ],
    });
    expect(harness.audit.create).toHaveBeenCalledTimes(1);
    const auditPayload = harness.audit.create.mock.calls[0][0].data;
    expect(auditPayload.action).toBe('INVENTORY_RECEIVED');
    expect(auditPayload.entityType).toBe('InventoryReceipt');
    expect(auditPayload.metadata).toMatchObject({
      lineCount: 1,
      totalQty: 3,
      totalValue: 75,
    });
  });
});
