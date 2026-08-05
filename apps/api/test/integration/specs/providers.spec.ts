/**
 * Provider ports against real PostgreSQL.
 *
 * The unit specs cover resolution and the no-op contracts. What can only be proven
 * here:
 *
 *  • a provider mutation genuinely participates in the caller's rollback — which is
 *    also the behavioural proof that no provider opens a nested transaction, since
 *    one that did would survive the rollback;
 *  • the local multi-branch guard, which reads a real branch count;
 *  • that a product id from another tenant matches zero rows rather than mutating;
 *  • that the QuickBooks accounting provider writes byte-identical `SyncJob` and
 *    `SyncLog` shapes to the ones the existing repositories write, compared against
 *    rows produced by the real sale pipeline rather than against a hand-written
 *    expectation.
 *
 * `ProvidersModule` is compiled here in a purpose-built graph rather than being
 * added to the shared harness, because Slice 5 must stay inert: nothing in the
 * running application may be able to construct a provider yet.
 */

import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  Prisma,
  type PrismaClient,
} from '@hardware-pos/database';

import { validateEnv } from '../../../src/config/env.validation';
import { StorageModule } from '../../../src/common/storage/storage.module';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { PlatformModule } from '../../../src/modules/platform/platform.module';
import { ProvidersModule } from '../../../src/modules/providers/providers.module';
import { InventoryProviderFactory } from '../../../src/modules/providers/inventory/inventory-provider.factory';
import { AccountingProviderFactory } from '../../../src/modules/providers/accounting/accounting-provider.factory';
import { LocalInventoryProvider } from '../../../src/modules/providers/inventory/local-inventory.provider';
import { NoInventoryProvider } from '../../../src/modules/providers/inventory/no-inventory.provider';
import { QuickBooksInventoryProvider } from '../../../src/modules/providers/inventory/quickbooks-inventory.provider';
import { NoAccountingProvider } from '../../../src/modules/providers/accounting/no-accounting.provider';
import { QuickBooksAccountingProvider } from '../../../src/modules/providers/accounting/quickbooks-accounting.provider';
import {
  ProviderErrorCode,
  UnsafeMultiBranchInventoryError,
} from '../../../src/modules/providers/provider.errors';
import type { ProviderContext, StockLine } from '../../../src/modules/providers/provider.types';
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { SalesService } from '../../../src/modules/sales/sales.service';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedSecondTenant, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let prismaService: PrismaService;
let inventoryFactory: InventoryProviderFactory;
let accountingFactory: AccountingProviderFactory;
let salesService: SalesService;
let tile: SeededTenant;
let other: SeededTenant;
let ctx: ProviderContext;
let otherCtx: ProviderContext;
let owner: AuthenticatedUser;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  testModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      StorageModule,
      PrismaModule,
      PlatformModule,
      ProvidersModule,
      // Included only so the QuickBooks SyncJob/SyncLog shapes can be compared
      // against rows the REAL sale pipeline writes, rather than against a
      // hand-written expectation that could be wrong in the same way twice.
      SalesModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();

  prismaService = testModule.get(PrismaService);
  inventoryFactory = testModule.get(InventoryProviderFactory);
  accountingFactory = testModule.get(AccountingProviderFactory);
  salesService = testModule.get(SalesService);
});

afterAll(async () => {
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tile = await seedTileShopWithQuickBooks(prisma);
  other = await seedSecondTenant(prisma);
  ctx = { tenantId: tile.tenantId, branchId: tile.branchId };
  otherCtx = { tenantId: other.tenantId, branchId: other.branchId };
  owner = { id: tile.ownerId, tenantId: tile.tenantId, role: 'OWNER' };
});

/** Write an explicit profile straight to the database. */
async function giveProfile(
  tenant: SeededTenant,
  inventoryMode: InventoryMode,
  accountingProvider: AccountingProviderKind,
  businessType = BusinessType.RESTAURANT,
): Promise<void> {
  await prisma.tenantBusinessProfile.create({
    data: { tenantId: tenant.tenantId, businessType, inventoryMode, accountingProvider },
  });
}

async function onHand(productId: string): Promise<number> {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  return Number(product.quantityOnHand);
}

function line(productId: string, quantity: number, trackInventory = true): StockLine {
  return { productId, productName: 'Fixture Product', quantity, trackInventory };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1, 2, 10 — resolution against a real profile service and a real database
// ─────────────────────────────────────────────────────────────────────────────

describe('resolution through the real profile service', () => {
  it('a legacy tenant resolves the QuickBooks inventory provider', async () => {
    const provider = await inventoryFactory.forTenant(tile.tenantId);
    expect(provider).toBeInstanceOf(QuickBooksInventoryProvider);
    expect(provider.mode).toBe(InventoryMode.QUICKBOOKS);
    expect(await prisma.tenantBusinessProfile.count()).toBe(0);
  });

  it('a legacy tenant resolves the QuickBooks accounting provider', async () => {
    const provider = await accountingFactory.forTenant(tile.tenantId);
    expect(provider).toBeInstanceOf(QuickBooksAccountingProvider);
    expect(provider.provider).toBe(AccountingProviderKind.QUICKBOOKS);
  });

  it('an explicit LOCAL/NONE profile resolves Local + NoAccounting', async () => {
    await giveProfile(other, InventoryMode.LOCAL, AccountingProviderKind.NONE);

    expect(await inventoryFactory.forTenant(other.tenantId)).toBeInstanceOf(LocalInventoryProvider);
    expect(await accountingFactory.forTenant(other.tenantId)).toBeInstanceOf(NoAccountingProvider);
  });

  it('DISABLED resolves NoInventoryProvider', async () => {
    await giveProfile(other, InventoryMode.DISABLED, AccountingProviderKind.NONE);
    expect(await inventoryFactory.forTenant(other.tenantId)).toBeInstanceOf(NoInventoryProvider);
  });

  it("tenant A's resolution cannot use tenant B's profile", async () => {
    await giveProfile(other, InventoryMode.LOCAL, AccountingProviderKind.NONE);

    // Tile has no profile row, so it must still resolve QuickBooks even though the
    // only profile row in the database says LOCAL/NONE.
    expect(await inventoryFactory.forTenant(tile.tenantId)).toBeInstanceOf(
      QuickBooksInventoryProvider,
    );
    expect(await accountingFactory.forTenant(tile.tenantId)).toBeInstanceOf(
      QuickBooksAccountingProvider,
    );
  });

  it('changing a profile takes effect on the very next resolution', async () => {
    expect(await inventoryFactory.forTenant(other.tenantId)).toBeInstanceOf(
      QuickBooksInventoryProvider,
    );

    await giveProfile(other, InventoryMode.DISABLED, AccountingProviderKind.NONE);

    // Decision D11: no cross-request cache on this path.
    expect(await inventoryFactory.forTenant(other.tenantId)).toBeInstanceOf(NoInventoryProvider);
  });

  it('EXTERNAL fails closed against a real profile row', async () => {
    await giveProfile(other, InventoryMode.EXTERNAL, AccountingProviderKind.NONE);
    await expect(inventoryFactory.forTenant(other.tenantId)).rejects.toMatchObject({
      code: ProviderErrorCode.UNSUPPORTED_INVENTORY_PROVIDER,
    });
  });

  it('FUTURE_EXTERNAL fails closed against a real profile row', async () => {
    await giveProfile(other, InventoryMode.LOCAL, AccountingProviderKind.FUTURE_EXTERNAL);
    await expect(accountingFactory.forTenant(other.tenantId)).rejects.toMatchObject({
      code: ProviderErrorCode.UNSUPPORTED_ACCOUNTING_PROVIDER,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QuickBooks inventory — today's behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('QuickBooksInventoryProvider', () => {
  let provider: QuickBooksInventoryProvider;

  beforeEach(() => {
    provider = testModule.get(QuickBooksInventoryProvider);
  });

  it('reports the cached on-hand quantity', async () => {
    const map = await provider.getAvailability(ctx, [tile.productAId, tile.serviceProductId]);

    expect(map.get(tile.productAId)).toEqual({
      productId: tile.productAId,
      trackInventory: true,
      quantityOnHand: 100,
      isUnlimited: false,
    });
    // A Service product never constrains a sale.
    expect(map.get(tile.serviceProductId)).toMatchObject({
      trackInventory: false,
      quantityOnHand: null,
      isUnlimited: true,
    });
  });

  it('omits a product from another tenant rather than reporting it', async () => {
    const map = await provider.getAvailability(ctx, [other.productAId]);
    expect(map.size).toBe(0);
  });

  it('reduces stock inside the caller transaction', async () => {
    await prismaService.$transaction((tx) =>
      provider.reduceStock(tx, ctx, [line(tile.productAId, 3)]),
    );
    expect(await onHand(tile.productAId)).toBe(97);
  });

  it('aggregates a product repeated across lines', async () => {
    await prismaService.$transaction((tx) =>
      provider.reduceStock(tx, ctx, [line(tile.productAId, 2), line(tile.productAId, 3)]),
    );
    expect(await onHand(tile.productAId)).toBe(95);
  });

  it('skips untracked lines', async () => {
    await prismaService.$transaction((tx) =>
      provider.reduceStock(tx, ctx, [line(tile.serviceProductId, 5, false)]),
    );
    expect(await onHand(tile.serviceProductId)).toBe(0);
  });

  it('refuses to oversell, with the exact existing message', async () => {
    await expect(
      prismaService.$transaction((tx) =>
        provider.reduceStock(tx, ctx, [
          { productId: tile.productAId, productName: 'Fixture Product A', quantity: 101, trackInventory: true },
        ]),
      ),
    ).rejects.toThrow('Insufficient stock for Fixture Product A');
    expect(await onHand(tile.productAId)).toBe(100);
  });

  it('restores stock for a return, only for Inventory products', async () => {
    await prismaService.$transaction((tx) =>
      provider.restoreStock(tx, ctx, [line(tile.productAId, 4), line(tile.serviceProductId, 4)]),
    );

    expect(await onHand(tile.productAId)).toBe(104);
    expect(await onHand(tile.serviceProductId)).toBe(0);
  });

  it('applies a signed adjustment', async () => {
    await prismaService.$transaction((tx) =>
      provider.adjustStock(tx, ctx, [
        { productId: tile.productAId, productName: 'A', delta: -10, trackInventory: true },
      ]),
    );
    expect(await onHand(tile.productAId)).toBe(90);
  });

  it('has NO multi-branch guard — an existing multi-branch tenant keeps working', async () => {
    await prisma.branch.create({
      data: { tenantId: tile.tenantId, name: 'Second Branch', code: 'SEC' },
    });

    // The cached column is a cache of an upstream total, not a branch-level claim,
    // so this stays exactly as correct (and exactly as approximate) as it is today.
    await expect(
      prismaService.$transaction((tx) => provider.reduceStock(tx, ctx, [line(tile.productAId, 1)])),
    ).resolves.toBeUndefined();
    expect(await onHand(tile.productAId)).toBe(99);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20, 21 — LocalInventoryProvider
// ─────────────────────────────────────────────────────────────────────────────

describe('LocalInventoryProvider', () => {
  let provider: LocalInventoryProvider;

  beforeEach(() => {
    provider = testModule.get(LocalInventoryProvider);
  });

  it('works for a single-branch tenant', async () => {
    await prismaService.$transaction((tx) =>
      provider.reduceStock(tx, ctx, [line(tile.productAId, 5)]),
    );
    expect(await onHand(tile.productAId)).toBe(95);
  });

  it('rejects unsafe multi-branch use rather than serving wrong numbers', async () => {
    await prisma.branch.create({
      data: { tenantId: tile.tenantId, name: 'Second Branch', code: 'SEC' },
    });

    await expect(
      prismaService.$transaction((tx) => provider.reduceStock(tx, ctx, [line(tile.productAId, 1)])),
    ).rejects.toThrow(UnsafeMultiBranchInventoryError);
    expect(await onHand(tile.productAId)).toBe(100);
  });

  it.each([
    ['getAvailability', (p: LocalInventoryProvider) => p.getAvailability(ctx, [tile.productAId])],
    [
      'restoreStock',
      (p: LocalInventoryProvider) =>
        prismaService.$transaction((tx) => p.restoreStock(tx, ctx, [line(tile.productAId, 1)])),
    ],
    [
      'adjustStock',
      (p: LocalInventoryProvider) =>
        prismaService.$transaction((tx) =>
          p.adjustStock(tx, ctx, [
            { productId: tile.productAId, productName: 'A', delta: 1, trackInventory: true },
          ]),
        ),
    ],
  ])('guards %s too — the refusal is not just on the sale path', async (_name, call) => {
    await prisma.branch.create({
      data: { tenantId: tile.tenantId, name: 'Second Branch', code: 'SEC' },
    });
    await expect(call(provider)).rejects.toThrow(UnsafeMultiBranchInventoryError);
  });

  it('counts only ACTIVE branches, so a closed branch does not block a tenant', async () => {
    await prisma.branch.create({
      data: { tenantId: tile.tenantId, name: 'Closed Branch', code: 'OLD', isActive: false },
    });

    await expect(
      prismaService.$transaction((tx) => provider.reduceStock(tx, ctx, [line(tile.productAId, 1)])),
    ).resolves.toBeUndefined();
  });

  it("re-checks on every call, so opening a branch takes effect immediately", async () => {
    await prismaService.$transaction((tx) =>
      provider.reduceStock(tx, ctx, [line(tile.productAId, 1)]),
    );

    await prisma.branch.create({
      data: { tenantId: tile.tenantId, name: 'Second Branch', code: 'SEC' },
    });

    await expect(
      prismaService.$transaction((tx) => provider.reduceStock(tx, ctx, [line(tile.productAId, 1)])),
    ).rejects.toThrow(UnsafeMultiBranchInventoryError);
  });

  it('carries a machine-readable code and a 409', async () => {
    await prisma.branch.create({
      data: { tenantId: tile.tenantId, name: 'Second Branch', code: 'SEC' },
    });
    let err: UnsafeMultiBranchInventoryError | undefined;
    try {
      await prismaService.$transaction((tx) =>
        provider.reduceStock(tx, ctx, [line(tile.productAId, 1)]),
      );
    } catch (caught) {
      err = caught as UnsafeMultiBranchInventoryError;
    }

    expect(err).toBeInstanceOf(UnsafeMultiBranchInventoryError);
    if (!err) throw new Error('expected the guard to refuse');
    expect(err.code).toBe(ProviderErrorCode.UNSAFE_MULTI_BRANCH_INVENTORY);
    expect(err.getStatus()).toBe(409);
    // No secret in the message — an id and a count only.
    expect(err.message).not.toMatch(/token|secret|password|realm/i);
  });

  it('cannot modify another tenant\'s product', async () => {
    const before = await onHand(other.productAId);

    // `other` also has one branch, so the guard does not mask this. The tenantId in
    // the predicate is what makes a foreign id match zero rows.
    await expect(
      prismaService.$transaction((tx) =>
        provider.reduceStock(tx, ctx, [
          { productId: other.productAId, productName: 'Foreign', quantity: 1, trackInventory: true },
        ]),
      ),
    ).rejects.toThrow('Insufficient stock for Foreign');

    expect(await onHand(other.productAId)).toBe(before);
  });

  it("cannot restore another tenant's product either", async () => {
    const before = await onHand(other.productAId);
    await prismaService.$transaction((tx) =>
      provider.restoreStock(tx, ctx, [line(other.productAId, 10)]),
    );
    expect(await onHand(other.productAId)).toBe(before);
  });

  it("cannot adjust another tenant's product either", async () => {
    const before = await onHand(other.productAId);
    await prismaService.$transaction((tx) =>
      provider.adjustStock(tx, ctx, [
        { productId: other.productAId, productName: 'Foreign', delta: 50, trackInventory: true },
      ]),
    );
    expect(await onHand(other.productAId)).toBe(before);
  });

  it('reports no upstream system to synchronise with', async () => {
    await expect(provider.synchronize(ctx)).resolves.toMatchObject({
      requested: false,
      queued: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11 — NoInventoryProvider writes nothing
// ─────────────────────────────────────────────────────────────────────────────

describe('NoInventoryProvider against a real database', () => {
  let provider: NoInventoryProvider;

  beforeEach(() => {
    provider = testModule.get(NoInventoryProvider);
  });

  it('leaves stock untouched and creates no sync rows', async () => {
    await prismaService.$transaction(async (tx) => {
      await provider.reduceStock(tx, ctx, [line(tile.productAId, 10)]);
      await provider.restoreStock(tx, ctx, [line(tile.productAId, 10)]);
      await provider.adjustStock(tx, ctx, [
        { productId: tile.productAId, productName: 'A', delta: -5, trackInventory: true },
      ]);
    });

    expect(await onHand(tile.productAId)).toBe(100);
    expect(await prisma.syncJob.count()).toBe(0);
    expect(await prisma.syncLog.count()).toBe(0);
  });

  it('does not behave like LocalInventoryProvider even at zero stock', async () => {
    await prisma.product.update({
      where: { id: tile.productAId },
      data: { quantityOnHand: 0 },
    });

    // Local would refuse; this must succeed and change nothing.
    await expect(
      prismaService.$transaction((tx) => provider.reduceStock(tx, ctx, [line(tile.productAId, 5)])),
    ).resolves.toBeUndefined();
    expect(await onHand(tile.productAId)).toBe(0);
  });

  it('synchronize creates no sync rows', async () => {
    await provider.synchronize(ctx);
    expect(await prisma.syncJob.count()).toBe(0);
    expect(await prisma.syncLog.count()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12, 13 — NoAccountingProvider writes nothing
// ─────────────────────────────────────────────────────────────────────────────

describe('NoAccountingProvider against a real database', () => {
  let provider: NoAccountingProvider;

  beforeEach(() => {
    provider = testModule.get(NoAccountingProvider);
  });

  it('postSale creates no SyncJob and no SyncLog', async () => {
    await prismaService.$transaction((tx) => provider.postSale(tx, ctx, 'sal_whatever', null));

    expect(await prisma.syncJob.count()).toBe(0);
    expect(await prisma.syncLog.count()).toBe(0);
  });

  it('postReturn creates no SyncJob and no SyncLog', async () => {
    await prismaService.$transaction((tx) => provider.postReturn(tx, ctx, 'ret_whatever', null));

    expect(await prisma.syncJob.count()).toBe(0);
    expect(await prisma.syncLog.count()).toBe(0);
  });

  it('creates no QuickBooks document id anywhere', async () => {
    await prismaService.$transaction(async (tx) => {
      await provider.postSale(tx, ctx, 'sal_whatever', null);
      await provider.postReturn(tx, ctx, 'ret_whatever', null);
    });

    const sales = await prisma.sale.findMany();
    const returns = await prisma.return.findMany();
    expect(sales).toHaveLength(0);
    expect(returns).toHaveLength(0);
    // And no QuickBooks mapping was invented either.
    expect(await prisma.quickBooksMapping.count()).toBe(0);
  });

  it('synchronize creates nothing and claims nothing', async () => {
    const outcome = await provider.synchronize(ctx);

    expect(outcome).toMatchObject({ requested: false, queued: 0 });
    expect(await prisma.syncJob.count()).toBe(0);
    expect(await prisma.syncLog.count()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 27, 28 — the QuickBooks accounting provider preserves the persisted row shapes
// ─────────────────────────────────────────────────────────────────────────────

describe('QuickBooksAccountingProvider preserves the existing outbox row shapes', () => {
  /** Fields that legitimately differ between two rows: identity and time. */
  const VOLATILE = ['id', 'entityId', 'createdAt', 'updatedAt', 'scheduledAt', 'startedAt', 'completedAt'];

  function stable<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
    return Object.fromEntries(Object.entries(row).filter(([key]) => !VOLATILE.includes(key)));
  }

  it('writes the same SyncJob shape the real sale pipeline writes', async () => {
    // 1. The real pipeline, untouched.
    const sale = await salesService.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      registerId: tile.registerId,
      items: [{ productId: tile.productAId, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 1000 }],
    });
    const pipelineJob = await prisma.syncJob.findFirstOrThrow({ where: { entityId: sale.id } });
    const pipelineLog = await prisma.syncLog.findFirstOrThrow({ where: { entityId: sale.id } });

    // 2. The provider, on a clean slate.
    await prisma.syncJob.deleteMany();
    await prisma.syncLog.deleteMany();
    const provider = testModule.get(QuickBooksAccountingProvider);
    await prismaService.$transaction((tx) => provider.postSale(tx, ctx, sale.id, 'SALES_RECEIPT'));

    const providerJob = await prisma.syncJob.findFirstOrThrow({ where: { entityId: sale.id } });
    const providerLog = await prisma.syncLog.findFirstOrThrow({ where: { entityId: sale.id } });

    expect(stable(providerJob)).toEqual(stable(pipelineJob));
    expect(stable(providerLog)).toEqual(stable(pipelineLog));
  });

  it('writes exactly one job and one log per post', async () => {
    const provider = testModule.get(QuickBooksAccountingProvider);
    await prismaService.$transaction((tx) => provider.postSale(tx, ctx, 'sal_1', 'SALES_RECEIPT'));

    expect(await prisma.syncJob.count()).toBe(1);
    expect(await prisma.syncLog.count()).toBe(1);
  });

  it('writes the return job with the RETURN_SYNC type', async () => {
    const provider = testModule.get(QuickBooksAccountingProvider);
    await prismaService.$transaction((tx) => provider.postReturn(tx, ctx, 'ret_1', 'REFUND_RECEIPT'));

    const job = await prisma.syncJob.findFirstOrThrow();
    expect(job.type).toBe('RETURN_SYNC');
    expect(job.entityType).toBe('RETURN');
    expect(job.direction).toBe('OUTBOUND');
    expect(job.status).toBe('PENDING');
    expect(job.tenantId).toBe(tile.tenantId);
  });

  it('scopes the job to the context tenant', async () => {
    const provider = testModule.get(QuickBooksAccountingProvider);
    await prismaService.$transaction((tx) => provider.postSale(tx, otherCtx, 'sal_x', 'SALES_RECEIPT'));

    const job = await prisma.syncJob.findFirstOrThrow();
    expect(job.tenantId).toBe(other.tenantId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 18, 19 — transaction participation
// ─────────────────────────────────────────────────────────────────────────────

describe('provider mutations participate in the caller transaction', () => {
  class CallerAborted extends Error {}

  it('a stock reduction is rolled back when the caller throws afterwards', async () => {
    const provider = testModule.get(QuickBooksInventoryProvider);

    await expect(
      prismaService.$transaction(async (tx) => {
        await provider.reduceStock(tx, ctx, [line(tile.productAId, 10)]);
        // Something later in the sale fails — a credit-limit check, a numbering
        // collision, anything.
        throw new CallerAborted('caller aborted after the provider succeeded');
      }),
    ).rejects.toThrow(CallerAborted);

    // If the provider had opened its own transaction, the decrement would have
    // committed independently and this would be 90. That is the behavioural proof
    // that no nested transaction is started.
    expect(await onHand(tile.productAId)).toBe(100);
  });

  it('a local stock reduction is rolled back too', async () => {
    const provider = testModule.get(LocalInventoryProvider);

    await expect(
      prismaService.$transaction(async (tx) => {
        await provider.reduceStock(tx, ctx, [line(tile.productAId, 7)]);
        throw new CallerAborted('abort');
      }),
    ).rejects.toThrow(CallerAborted);

    expect(await onHand(tile.productAId)).toBe(100);
  });

  it('a restock is rolled back', async () => {
    const provider = testModule.get(QuickBooksInventoryProvider);

    await expect(
      prismaService.$transaction(async (tx) => {
        await provider.restoreStock(tx, ctx, [line(tile.productAId, 25)]);
        throw new CallerAborted('abort');
      }),
    ).rejects.toThrow(CallerAborted);

    expect(await onHand(tile.productAId)).toBe(100);
  });

  it('an enqueued sync job is rolled back — the outbox stays an outbox', async () => {
    const provider = testModule.get(QuickBooksAccountingProvider);

    await expect(
      prismaService.$transaction(async (tx) => {
        await provider.postSale(tx, ctx, 'sal_1', 'SALES_RECEIPT');
        throw new CallerAborted('abort');
      }),
    ).rejects.toThrow(CallerAborted);

    // An orphan job for a sale that never existed is exactly what the outbox
    // pattern must prevent.
    expect(await prisma.syncJob.count()).toBe(0);
    expect(await prisma.syncLog.count()).toBe(0);
  });

  it('a provider failure rolls back the caller\'s own earlier writes', async () => {
    const provider = testModule.get(QuickBooksInventoryProvider);
    const before = await prisma.auditLog.count();

    await expect(
      prismaService.$transaction(async (tx) => {
        // The caller writes first...
        await tx.auditLog.create({
          data: { tenantId: tile.tenantId, action: 'test.before_provider' },
        });
        // ...then the provider refuses.
        await provider.reduceStock(tx, ctx, [
          { productId: tile.productAId, productName: 'Fixture Product A', quantity: 999, trackInventory: true },
        ]);
      }),
    ).rejects.toThrow('Insufficient stock');

    expect(await prisma.auditLog.count()).toBe(before);
  });

  it('stock and outbox commit together when the caller succeeds', async () => {
    const inventory = testModule.get(QuickBooksInventoryProvider);
    const accounting = testModule.get(QuickBooksAccountingProvider);

    await prismaService.$transaction(async (tx) => {
      await inventory.reduceStock(tx, ctx, [line(tile.productAId, 2)]);
      await accounting.postSale(tx, ctx, 'sal_1', 'SALES_RECEIPT');
    });

    expect(await onHand(tile.productAId)).toBe(98);
    expect(await prisma.syncJob.count()).toBe(1);
  });

  it('the no-op providers are safe inside a transaction the caller rolls back', async () => {
    const inventory = testModule.get(NoInventoryProvider);
    const accounting = testModule.get(NoAccountingProvider);

    await expect(
      prismaService.$transaction(async (tx: Prisma.TransactionClient) => {
        await inventory.reduceStock(tx, ctx, [line(tile.productAId, 1)]);
        await accounting.postSale(tx, ctx, 'sal_1', null);
        throw new CallerAborted('abort');
      }),
    ).rejects.toThrow(CallerAborted);

    expect(await onHand(tile.productAId)).toBe(100);
    expect(await prisma.syncJob.count()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 23-26 — existing behaviour is unchanged
// ─────────────────────────────────────────────────────────────────────────────

describe('the existing pipeline is untouched by the providers existing', () => {
  it('a paid sale still completes as PAID with a SALES_RECEIPT and one SyncJob', async () => {
    const sale = await salesService.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      registerId: tile.registerId,
      items: [{ productId: tile.productAId, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 1000 }],
    });

    expect(sale.paymentStatus).toBe('PAID');
    expect(sale.quickbooksDocumentType).toBe('SALES_RECEIPT');
    expect(await prisma.syncJob.count({ where: { entityId: sale.id } })).toBe(1);
    expect(await onHand(tile.productAId)).toBe(99);
  });

  it('a credit sale still becomes an INVOICE', async () => {
    const sale = await salesService.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      customerId: tile.creditCustomerId,
      items: [{ productId: tile.productAId, quantity: 1 }],
      payments: [],
    });

    expect(sale.paymentStatus).toBe('UNPAID');
    expect(sale.quickbooksDocumentType).toBe('INVOICE');
  });

  /**
   * Updated in Slice 6A. This test previously asserted that a LOCAL/NONE profile
   * still produced a QuickBooks-shaped sale, and its comment said the day it failed,
   * a provider had been adopted and that must be deliberate. Slice 6A is that
   * deliberate adoption — for ACCOUNTING only — so the assertion now records the new
   * split: accounting follows the provider, inventory still does not.
   */
  it('accounting now follows the profile, while inventory deliberately does not', async () => {
    await giveProfile(tile, InventoryMode.LOCAL, AccountingProviderKind.NONE);

    const sale = await salesService.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      registerId: tile.registerId,
      items: [{ productId: tile.productAId, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 1000 }],
    });

    // Adopted in Slice 6A: no external accounting for a NONE tenant.
    expect(sale.quickbooksDocumentType).toBeNull();
    expect(await prisma.syncJob.count({ where: { entityId: sale.id } })).toBe(0);

    // NOT adopted: stock still moves through `decrementStock`, not LocalInventoryProvider.
    // This half remains the tripwire for Slice 6B.
    expect(await onHand(tile.productAId)).toBe(99);
  });

  it('overselling is still impossible through the real pipeline', async () => {
    await expect(
      salesService.complete(tile.tenantId, owner, {
        branchId: tile.branchId,
        items: [{ productId: tile.productAId, quantity: 101 }],
        payments: [{ method: 'CASH', amount: 101_000 }],
      }),
    ).rejects.toThrow(/Insufficient stock/);
    expect(await onHand(tile.productAId)).toBe(100);
  });
});
