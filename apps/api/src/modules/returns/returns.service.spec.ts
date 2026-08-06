import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { ReturnsService } from './returns.service';
import { AccountingProviderFactory } from '../providers/accounting/accounting-provider.factory';
import { NoAccountingProvider } from '../providers/accounting/no-accounting.provider';
import { QuickBooksAccountingProvider } from '../providers/accounting/quickbooks-accounting.provider';
import { InventoryProviderFactory } from '../providers/inventory/inventory-provider.factory';
import { LocalInventoryProvider } from '../providers/inventory/local-inventory.provider';
import { NoInventoryProvider } from '../providers/inventory/no-inventory.provider';
import { QuickBooksInventoryProvider } from '../providers/inventory/quickbooks-inventory.provider';
import type { ReturnsRepository } from './returns.repository';
import type { SettingsService } from '../settings/settings.service';
import type { AuthService } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/auth.types';

/** Build a completed-sale fixture (numbers stand in for Prisma Decimals). */
function makeSale(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sale1',
    saleNumber: 'S-000001',
    status: 'COMPLETED',
    branchId: 'brn1',
    registerId: 'reg1',
    customerId: null,
    subtotal: 400,
    totalDiscount: 0,
    orderDiscountAmount: 0,
    taxAmount: 0,
    total: 400,
    paidAmount: 400,
    returnedAmount: 0,
    paymentStatus: 'PAID',
    // Accounting provenance. Every completed sale carries these — the field was
    // non-nullable before Slice 6A, and 317 of 317 rows in the development
    // database have a document type. The fixture simply omitted them; Slice 6B
    // reads them to decide which accounting system a return must reverse.
    quickbooksDocumentType: 'SALES_RECEIPT',
    quickbooksDocumentId: null,
    syncStatus: 'PENDING',
    completedAt: new Date(),
    createdAt: new Date(),
    customer: null,
    payments: [{ method: 'CASH' }],
    items: [
      {
        id: 'si1',
        productId: 'p1',
        productName: 'Hammer',
        sku: 'HAM-1',
        unitPrice: 100,
        quantity: 4,
        discountAmount: 0,
        lineTotal: 400,
        returnedQuantity: 0,
        product: { id: 'p1', imageUrl: null },
      },
    ],
    ...overrides,
  } as never;
}

const RETURN_SETTINGS = {
  returnPeriodDays: 30,
  cashierReturnValueLimit: 5000,
  allowStoreCredit: true,
  allowedRefundMethods: ['CASH', 'CARD', 'BANK_TRANSFER', 'STORE_CREDIT'],
  requireApprovalForNonGoodCondition: true,
  requireApprovalForOtherReason: false,
  quickbooksRefundReceiptDepositAccountRef: null,
};

const SETTINGS = {
  currency: 'LKR',
  taxRatePercent: 0,
  taxInclusive: false,
  highDiscountThresholdPercent: 10,
  receiptFooter: 'Thanks',
  returns: RETURN_SETTINGS,
};

const CASHIER: AuthenticatedUser = {
  id: 'u1',
  tenantId: 't1',
  role: 'CASHIER',
  activeBranchId: null,
};

function makeService(repo: Partial<ReturnsRepository>) {
  const settings = { getSettings: () => SETTINGS } as unknown as SettingsService;
  const auth = {
    findUserByPin: jest.fn(),
    findUserById: jest.fn(),
  } as unknown as AuthService;
  const jwt = { signAsync: jest.fn(), verify: jest.fn() } as never;
  const syncQueue = { requeueReturn: jest.fn() } as never;
  // The real factory, wired to the real providers: these tests assert the QuickBooks
  // document decision, so stubbing the provider would assert the stub. Only
  // `BusinessProfileService` is absent, and deliberately — `forSale` resolves from
  // the sale's own provenance and must never reach the tenant profile. If it ever
  // did, the `null` here would throw and the test would say so.
  const accounting = new AccountingProviderFactory(
    null as never,
    new QuickBooksAccountingProvider(syncQueue, null as never),
    new NoAccountingProvider(),
  );
  // Same reasoning for inventory: the real factory over the real providers, with
  // `BusinessProfileService` stubbed to the legacy QuickBooks default rather than
  // absent, because unlike accounting the inventory provider IS resolved from the
  // tenant profile.
  const inventory = new InventoryProviderFactory(
    { getEffectiveProfile: async () => ({ inventoryMode: 'QUICKBOOKS' }) } as never,
    new QuickBooksInventoryProvider(null as never, null as never),
    new LocalInventoryProvider(null as never),
    new NoInventoryProvider(),
  );
  return new ReturnsService(
    repo as ReturnsRepository,
    settings,
    auth,
    jwt,
    syncQueue,
    accounting,
    inventory,
  );
}

const goodItem = {
  returnReason: 'CHANGED_MIND' as const,
  itemCondition: 'GOOD' as const,
  stockDisposition: 'RETURN_TO_STOCK' as const,
};

describe('ReturnsService.preview', () => {
  it('computes the refund and needs no approval for a within-limit good cash return', async () => {
    const service = makeService({ findSaleForReturn: jest.fn().mockResolvedValue(makeSale()) });
    const preview = await service.preview('t1', CASHIER, {
      originalSaleId: 'sale1',
      items: [{ saleItemId: 'si1', returnQuantity: 2, ...goodItem }],
      refundMethod: 'CASH',
    });
    expect(preview.refundTotal).toBe(200);
    expect(preview.subtotal).toBe(200);
    expect(preview.requiresApproval).toBe(false);
    expect(preview.quickbooksDocumentType).toBe('REFUND_RECEIPT');
  });

  it('rejects a return quantity greater than the available quantity', async () => {
    const service = makeService({ findSaleForReturn: jest.fn().mockResolvedValue(makeSale()) });
    await expect(
      service.preview('t1', CASHIER, {
        originalSaleId: 'sale1',
        items: [{ saleItemId: 'si1', returnQuantity: 5, ...goodItem }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('excludes already-returned quantity from the available quantity', async () => {
    const sale = makeSale({
      items: [
        {
          id: 'si1',
          productId: 'p1',
          productName: 'Hammer',
          sku: 'HAM-1',
          unitPrice: 100,
          quantity: 4,
          discountAmount: 0,
          lineTotal: 400,
          returnedQuantity: 3, // only 1 left
          product: { id: 'p1', imageUrl: null },
        },
      ],
    });
    const service = makeService({ findSaleForReturn: jest.fn().mockResolvedValue(sale) });
    await expect(
      service.preview('t1', CASHIER, {
        originalSaleId: 'sale1',
        items: [{ saleItemId: 'si1', returnQuantity: 2, ...goodItem }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forbids returning a damaged item to normal stock', async () => {
    const service = makeService({ findSaleForReturn: jest.fn().mockResolvedValue(makeSale()) });
    await expect(
      service.preview('t1', CASHIER, {
        originalSaleId: 'sale1',
        items: [
          {
            saleItemId: 'si1',
            returnQuantity: 1,
            returnReason: 'DAMAGED',
            itemCondition: 'DAMAGED',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires manager approval for a damaged item', async () => {
    const service = makeService({ findSaleForReturn: jest.fn().mockResolvedValue(makeSale()) });
    const preview = await service.preview('t1', CASHIER, {
      originalSaleId: 'sale1',
      items: [
        {
          saleItemId: 'si1',
          returnQuantity: 1,
          returnReason: 'DAMAGED',
          itemCondition: 'DAMAGED',
          stockDisposition: 'DAMAGED_STOCK',
        },
      ],
      refundMethod: 'CASH',
    });
    expect(preview.requiresApproval).toBe(true);
    expect(preview.approvalReasons.join(' ')).toMatch(/damaged/i);
  });

  it('requires approval for a full-sale return', async () => {
    const service = makeService({ findSaleForReturn: jest.fn().mockResolvedValue(makeSale()) });
    const preview = await service.preview('t1', CASHIER, {
      originalSaleId: 'sale1',
      items: [{ saleItemId: 'si1', returnQuantity: 4, ...goodItem }], // all 4 purchased
      refundMethod: 'CASH',
    });
    expect(preview.isFullReturn).toBe(true);
    expect(preview.requiresApproval).toBe(true);
  });
});

describe('ReturnsService.complete', () => {
  it('returns the existing return for a replayed idempotency key (no double-create)', async () => {
    const existing = { id: 'ret1', returnNumber: 'R-000001' } as never;
    const createCompleted = jest.fn();
    const service = makeService({
      findByIdempotencyKey: jest.fn().mockResolvedValue(existing),
      createCompleted,
    });
    const result = await service.complete(
      't1',
      CASHIER,
      {
        originalSaleId: 'sale1',
        items: [{ saleItemId: 'si1', returnQuantity: 2, ...goodItem }],
        refundMethod: 'CASH',
        idempotencyKey: 'idem-1',
      },
      null,
    );
    expect(result).toBe(existing);
    expect(createCompleted).not.toHaveBeenCalled();
  });

  it('blocks a high-risk return without a manager approval token', async () => {
    const createCompleted = jest.fn();
    const service = makeService({
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      findSaleForReturn: jest.fn().mockResolvedValue(makeSale()),
      createCompleted,
    });
    await expect(
      service.complete(
        't1',
        CASHIER,
        {
          originalSaleId: 'sale1',
          items: [{ saleItemId: 'si1', returnQuantity: 4, ...goodItem }], // full return → approval
          refundMethod: 'CASH',
        },
        null,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(createCompleted).not.toHaveBeenCalled();
  });

  it('persists a recomputed return on the happy path', async () => {
    const createdReturn = {
      id: 'ret1',
      returnNumber: 'R-000001',
      originalSaleId: 'sale1',
      tenant: { name: 'Acme' },
      originalSale: { total: 400, returnedAmount: 200, saleNumber: 'S-000001' },
      branch: null,
      register: null,
      customer: null,
      createdBy: null,
      approvedBy: null,
      items: [],
      quickbooksDocumentType: 'REFUND_RECEIPT',
      completedAt: new Date(),
      createdAt: new Date(),
      subtotal: 200,
      productDiscountAdjustment: 0,
      orderDiscountAdjustment: 0,
      taxAdjustment: 0,
      refundTotal: 200,
      refundMethod: 'CASH',
      refundReference: null,
      syncStatus: 'PENDING',
    } as never;
    const createCompleted = jest.fn().mockResolvedValue(createdReturn);
    const service = makeService({
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
      findSaleForReturn: jest.fn().mockResolvedValue(makeSale()),
      createCompleted,
      createReceiptPrintJob: jest.fn().mockResolvedValue({ id: 'pj1' }),
      findByIdForTenant: jest.fn().mockResolvedValue(createdReturn),
    });

    const result = await service.complete(
      't1',
      CASHIER,
      {
        originalSaleId: 'sale1',
        items: [{ saleItemId: 'si1', returnQuantity: 2, ...goodItem }],
        refundMethod: 'CASH',
      },
      'idem-2',
    );

    expect(createCompleted).toHaveBeenCalledTimes(1);
    const arg = createCompleted.mock.calls[0][0];
    // The server recomputes — never trusts a client amount.
    expect(arg.refundTotal).toBe(200);
    expect(arg.items).toHaveLength(1);
    expect(arg.items[0].refundableAmount).toBe(200);
    expect(arg.quickbooksDocumentType).toBe('REFUND_RECEIPT');
    expect(result).toBe(createdReturn);
  });
});
