/**
 * Slice 6C-A — sale and return stock movement now goes through `InventoryProvider`.
 *
 * Three claims:
 *
 *  1. **Nothing changed for QuickBooks tenants.** Availability, overselling
 *     prevention, the decrement, the restock rules, and both error strings are the
 *     same, because `decrementStock` was *moved* into the providers rather than
 *     rewritten.
 *
 *  2. **Each mode behaves as specified.** LOCAL enforces its single-branch guard,
 *     DISABLED neither rejects nor moves anything, EXTERNAL fails closed.
 *
 *  3. **Stock and accounting share one transaction.** Either failing rolls back
 *     the other, in both directions and on both the sale and return paths.
 *
 * Inventory is resolved from the tenant's CURRENT mode — unlike accounting, which
 * comes from the sale's provenance. The `inventory mode transitions` block below
 * is what makes that safe.
 */

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
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { SalesService } from '../../../src/modules/sales/sales.service';
import { ReturnsModule } from '../../../src/modules/returns/returns.module';
import { ReturnsService } from '../../../src/modules/returns/returns.service';
import { PlatformModule } from '../../../src/modules/platform/platform.module';
import { ProductsModule } from '../../../src/modules/products/products.module';
import { ProductsService } from '../../../src/modules/products/products.service';
import { SyncQueueService } from '../../../src/modules/sync/queue/sync-queue.service';
import { BusinessProfileService } from '../../../src/modules/platform/business-profile.service';
import { UnsafeInventoryModeTransitionError } from '../../../src/modules/platform/platform.errors';
import { InventoryProviderFactory } from '../../../src/modules/providers/inventory/inventory-provider.factory';
import {
  UnsafeMultiBranchInventoryError,
  UnsupportedInventoryProviderError,
} from '../../../src/modules/providers/provider.errors';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';
import { CreateReturnDto } from '../../../src/modules/returns/dto/create-return.dto';
import { ApproveReturnDto } from '../../../src/modules/returns/dto/approve-return.dto';
import { UpdateBusinessProfileDto } from '../../../src/modules/platform/dto/update-business-profile.dto';

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
let inventoryFactory: InventoryProviderFactory;
let profiles: BusinessProfileService;
let syncQueue: SyncQueueService;
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
      PlatformModule,
      SalesModule,
      ReturnsModule,
      ProductsModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();

  sales = testModule.get(SalesService);
  returns = testModule.get(ReturnsService);
  inventoryFactory = testModule.get(InventoryProviderFactory);
  profiles = testModule.get(BusinessProfileService);
  syncQueue = testModule.get(SyncQueueService);
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
  owner = { id: tile.ownerId, tenantId: tile.tenantId, role: 'OWNER' , activeBranchId: null };
  otherOwner = { id: other.ownerId, tenantId: other.tenantId, role: 'OWNER' , activeBranchId: null };
});

// ── fixtures ────────────────────────────────────────────────────────────────

async function giveProfile(
  tenant: SeededTenant,
  inventoryMode: InventoryMode,
  accountingProvider: AccountingProviderKind = AccountingProviderKind.QUICKBOOKS,
): Promise<void> {
  await prisma.tenantBusinessProfile.upsert({
    where: { tenantId: tenant.tenantId },
    update: { inventoryMode, accountingProvider },
    create: {
      tenantId: tenant.tenantId,
      businessType: BusinessType.RESTAURANT,
      inventoryMode,
      accountingProvider,
    },
  });
}

/** Open a second ACTIVE branch, which is what LOCAL inventory cannot serve. */
function openSecondBranch(tenant: SeededTenant) {
  return prisma.branch.create({
    data: { tenantId: tenant.tenantId, name: 'Second Branch', code: 'SECOND', isActive: true },
  });
}

function onHand(productId: string): Promise<number> {
  return prisma.product
    .findUniqueOrThrow({ where: { id: productId } })
    .then((p) => Number(p.quantityOnHand));
}

function paidSale(tenant: SeededTenant, actor: AuthenticatedUser, quantity = 2) {
  return sales.complete(tenant.tenantId, actor, {
    branchId: tenant.branchId,
    registerId: tenant.registerId,
    items: [{ productId: tenant.productAId, quantity }],
    payments: [{ method: 'CASH', amount: 1000 * quantity }],
  });
}

async function managerApproval(tenant: SeededTenant, saleId: string, refundTotal: number) {
  const approval = await returns.approve(
    tenant.tenantId,
    dto(ApproveReturnDto, { managerPin: MANAGER_PIN, originalSaleId: saleId, refundTotal }),
  );
  if (!approval.approved || !approval.approvalToken) {
    throw new Error(`Fixture approval refused: ${approval.reason ?? 'unknown'}`);
  }
  return approval.approvalToken;
}

async function returnOneUnit(
  tenant: SeededTenant,
  actor: AuthenticatedUser,
  saleId: string,
  opts: { condition?: string; disposition?: string; approve?: boolean } = {},
) {
  const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId } });
  const approvalToken = opts.approve ? await managerApproval(tenant, saleId, 1000) : undefined;

  return returns.complete(
    tenant.tenantId,
    actor,
    dto(CreateReturnDto, {
      originalSaleId: saleId,
      refundMethod: 'CASH',
      ...(approvalToken ? { approvalToken } : {}),
      items: [
        {
          saleItemId: saleItem.id,
          returnQuantity: 1,
          returnReason: 'CHANGED_MIND',
          itemCondition: opts.condition ?? 'GOOD',
          stockDisposition: opts.disposition ?? 'RETURN_TO_STOCK',
        },
      ],
    }),
    null,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1-12 — QuickBooks / legacy compatibility
// ─────────────────────────────────────────────────────────────────────────────

describe('1-5, 11 — legacy and explicit QUICKBOOKS sale stock behaviour is unchanged', () => {
  it('1 — a paid sale decrements by the quantity sold', async () => {
    const before = await onHand(tile.productAId);
    await paidSale(tile, owner, 3);
    expect(await onHand(tile.productAId)).toBe(before - 3);
  });

  it('2 — a credit sale decrements identically', async () => {
    const before = await onHand(tile.productAId);
    await sales.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      customerId: tile.creditCustomerId,
      items: [{ productId: tile.productAId, quantity: 2 }],
      payments: [],
    });
    expect(await onHand(tile.productAId)).toBe(before - 2);
  });

  it('3 — a partial sale decrements identically', async () => {
    const before = await onHand(tile.productAId);
    await sales.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      customerId: tile.creditCustomerId,
      items: [{ productId: tile.productAId, quantity: 2 }],
      payments: [{ method: 'CASH', amount: 800 }],
    });
    expect(await onHand(tile.productAId)).toBe(before - 2);
  });

  it('4 — an explicit QUICKBOOKS profile matches the legacy tenant exactly', async () => {
    const before = await onHand(tile.productAId);
    await paidSale(tile, owner, 2);
    const legacyAfter = await onHand(tile.productAId);

    await giveProfile(tile, InventoryMode.QUICKBOOKS);
    await paidSale(tile, owner, 2);
    const explicitAfter = await onHand(tile.productAId);

    expect(before - legacyAfter).toBe(2);
    expect(legacyAfter - explicitAfter).toBe(2);
  });

  it('5/11 — the read-time availability rejection keeps its exact wording', async () => {
    await expect(
      sales.complete(tile.tenantId, owner, {
        branchId: tile.branchId,
        items: [{ productId: tile.productAId, quantity: 100_000 }],
        payments: [{ method: 'CASH', amount: 100_000_000 }],
      }),
    ).rejects.toThrow('Insufficient stock for Fixture Product A (on hand 100, requested 100000)');
  });

  it('5 — a rejected sale moves no stock and writes nothing', async () => {
    const before = await onHand(tile.productAId);
    await expect(
      sales.complete(tile.tenantId, owner, {
        branchId: tile.branchId,
        items: [{ productId: tile.productAId, quantity: 100_000 }],
        payments: [{ method: 'CASH', amount: 100_000_000 }],
      }),
    ).rejects.toThrow();

    expect(await onHand(tile.productAId)).toBe(before);
    expect(await prisma.sale.count()).toBe(0);
    expect(await prisma.syncJob.count({ where: { entityType: 'SALE' } })).toBe(0);
  });

  it('a Service product never constrains a sale and never moves stock', async () => {
    const before = await onHand(tile.serviceProductId);
    await sales.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      items: [{ productId: tile.serviceProductId, quantity: 999 }],
      payments: [{ method: 'CASH', amount: 999 * 500 }],
    });
    expect(await onHand(tile.serviceProductId)).toBe(before);
  });
});

describe('6, 20 — overselling under concurrency', () => {
  /**
   * The read-time availability check cannot make this safe: both requests read
   * before either writes. Only the conditional `updateMany` inside the transaction
   * can, which is why it was moved into the providers rather than reimplemented.
   */
  async function raceForTheLastUnits(tenant: SeededTenant, actor: AuthenticatedUser) {
    await prisma.product.update({
      where: { id: tenant.productAId },
      data: { quantityOnHand: 1 },
    });

    const results = await Promise.allSettled([
      sales.complete(tenant.tenantId, actor, {
        branchId: tenant.branchId,
        items: [{ productId: tenant.productAId, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 1000 }],
      }),
      sales.complete(tenant.tenantId, actor, {
        branchId: tenant.branchId,
        items: [{ productId: tenant.productAId, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 1000 }],
      }),
    ]);
    return {
      fulfilled: results.filter((r) => r.status === 'fulfilled').length,
      onHand: await onHand(tenant.productAId),
    };
  }

  it('6 — QUICKBOOKS: two concurrent sales cannot both take the final unit', async () => {
    const { fulfilled, onHand: left } = await raceForTheLastUnits(tile, owner);
    expect(fulfilled).toBe(1);
    expect(left).toBe(0);
    expect(await prisma.sale.count()).toBe(1);
  });

  it('20 — LOCAL: the same guarantee', async () => {
    await giveProfile(tile, InventoryMode.LOCAL);
    const { fulfilled, onHand: left } = await raceForTheLastUnits(tile, owner);
    expect(fulfilled).toBe(1);
    expect(left).toBe(0);
    expect(await prisma.sale.count()).toBe(1);
  });

  it('the transactional decrement keeps its own wording, distinct from the read check', async () => {
    // Two different messages exist today and both must survive: the read-time check
    // names the quantities, the transactional guard does not. Reached directly,
    // because no request can get past the read check to provoke it deterministically.
    const inventory = await inventoryFactory.forTenant(tile.tenantId);

    await expect(
      prisma.$transaction((tx) =>
        inventory.reduceStock(tx, { tenantId: tile.tenantId, branchId: tile.branchId }, [
          {
            productId: tile.productAId,
            productName: 'Fixture Product A',
            quantity: 100_000,
            trackInventory: true,
          },
        ]),
      ),
    ).rejects.toThrow('Insufficient stock for Fixture Product A');

    const message = await prisma
      .$transaction((tx) =>
        inventory.reduceStock(tx, { tenantId: tile.tenantId, branchId: tile.branchId }, [
          {
            productId: tile.productAId,
            productName: 'Fixture Product A',
            quantity: 100_000,
            trackInventory: true,
          },
        ]),
      )
      .catch((e: Error) => e.message);
    expect(message).not.toContain('on hand');
  });
});

describe('7-10, 12 — return restock rules are unchanged', () => {
  it('7 — a GOOD / RETURN_TO_STOCK line restocks', async () => {
    const before = await onHand(tile.productAId);
    const sale = await paidSale(tile, owner, 2);
    await returnOneUnit(tile, owner, sale.id);
    expect(await onHand(tile.productAId)).toBe(before - 1);
  });

  it('8 — a DAMAGED item does not restock', async () => {
    const before = await onHand(tile.productAId);
    const sale = await paidSale(tile, owner, 2);
    await returnOneUnit(tile, owner, sale.id, {
      condition: 'DAMAGED',
      disposition: 'DAMAGED_STOCK',
      approve: true,
    });
    expect(await onHand(tile.productAId)).toBe(before - 2);
  });

  it('9 — an OPENED_USED item does not restock even if marked RETURN_TO_STOCK', async () => {
    const sale = await paidSale(tile, owner, 2);
    // The return domain refuses the combination outright — the pre-existing rule.
    await expect(
      returnOneUnit(tile, owner, sale.id, { condition: 'OPENED_USED', approve: true }),
    ).rejects.toThrow(/cannot be returned to normal stock/);
  });

  it('9 — a DO_NOT_RESTOCK disposition on a GOOD item does not restock', async () => {
    const before = await onHand(tile.productAId);
    const sale = await paidSale(tile, owner, 2);
    await returnOneUnit(tile, owner, sale.id, {
      disposition: 'DO_NOT_RESTOCK',
      approve: true,
    });
    expect(await onHand(tile.productAId)).toBe(before - 2);
  });

  it('10 — a returned Service line restocks nothing', async () => {
    const before = await onHand(tile.serviceProductId);
    const sale = await sales.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      items: [{ productId: tile.serviceProductId, quantity: 2 }],
      payments: [{ method: 'CASH', amount: 1000 }],
    });
    await returnOneUnit(tile, owner, sale.id);
    expect(await onHand(tile.serviceProductId)).toBe(before);
  });

  it('12 — return error wording is unchanged', async () => {
    const sale = await paidSale(tile, owner, 2);
    const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });
    await expect(
      returns.complete(
        tile.tenantId,
        owner,
        dto(CreateReturnDto, {
          originalSaleId: sale.id,
          refundMethod: 'CASH',
          items: [
            {
              saleItemId: saleItem.id,
              returnQuantity: 9,
              returnReason: 'CHANGED_MIND',
              itemCondition: 'GOOD',
              stockDisposition: 'RETURN_TO_STOCK',
            },
          ],
        }),
        null,
      ),
    ).rejects.toThrow(/Cannot return 9 of .*only 2 available/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13-21 — LOCAL inventory
// ─────────────────────────────────────────────────────────────────────────────

describe('13-17, 21 — LOCAL inventory, single active branch', () => {
  beforeEach(async () => {
    await giveProfile(tile, InventoryMode.LOCAL, AccountingProviderKind.NONE);
  });

  it('13 — availability is enforced', async () => {
    await expect(
      sales.complete(tile.tenantId, owner, {
        branchId: tile.branchId,
        items: [{ productId: tile.productAId, quantity: 100_000 }],
        payments: [{ method: 'CASH', amount: 100_000_000 }],
      }),
    ).rejects.toThrow(/Insufficient stock/);
  });

  it('14 — a completed sale reduces stock', async () => {
    const before = await onHand(tile.productAId);
    await paidSale(tile, owner, 2);
    expect(await onHand(tile.productAId)).toBe(before - 2);
  });

  it('15 — an eligible return restores stock', async () => {
    const before = await onHand(tile.productAId);
    const sale = await paidSale(tile, owner, 2);
    await returnOneUnit(tile, owner, sale.id);
    expect(await onHand(tile.productAId)).toBe(before - 1);
  });

  it('16 — a sale cannot reduce another tenant’s product', async () => {
    const foreignBefore = await onHand(other.productAId);
    await expect(
      sales.complete(tile.tenantId, owner, {
        branchId: tile.branchId,
        items: [{ productId: other.productAId, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 1000 }],
      }),
    ).rejects.toThrow(`Unknown product ${other.productAId}`);
    expect(await onHand(other.productAId)).toBe(foreignBefore);
  });

  it('17 — a return cannot restore another tenant’s product', async () => {
    const sale = await paidSale(tile, owner, 2);
    const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale.id } });
    // Repoint the line at a foreign product: the provider's tenant-scoped predicate
    // is the last defence, and it must match zero rows rather than mutate.
    await prisma.saleItem.update({
      where: { id: saleItem.id },
      data: { productId: other.productAId },
    });
    const foreignBefore = await onHand(other.productAId);

    await returnOneUnit(tile, owner, sale.id);

    expect(await onHand(other.productAId)).toBe(foreignBefore);
  });

  it('21 — the provider writes through the caller’s transaction, so a later failure undoes it', async () => {
    const before = await onHand(tile.productAId);
    const inventory = await inventoryFactory.forTenant(tile.tenantId);

    await expect(
      prisma.$transaction(async (tx) => {
        await inventory.reduceStock(tx, { tenantId: tile.tenantId, branchId: tile.branchId }, [
          { productId: tile.productAId, productName: 'Tile', quantity: 2, trackInventory: true },
        ]);
        // Visible inside the transaction …
        const mid = await tx.product.findUniqueOrThrow({ where: { id: tile.productAId } });
        expect(Number(mid.quantityOnHand)).toBe(before - 2);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');

    // … and gone after it rolls back, which could not happen if the provider had
    // opened its own connection.
    expect(await onHand(tile.productAId)).toBe(before);
  });
});

describe('18/19 — LOCAL inventory with more than one active branch fails closed', () => {
  beforeEach(async () => {
    await giveProfile(tile, InventoryMode.LOCAL, AccountingProviderKind.NONE);
  });

  it('18 — a sale is refused', async () => {
    await openSecondBranch(tile);
    const before = await onHand(tile.productAId);

    await expect(paidSale(tile, owner, 1)).rejects.toThrow(UnsafeMultiBranchInventoryError);

    expect(await onHand(tile.productAId)).toBe(before);
    expect(await prisma.sale.count()).toBe(0);
  });

  it('19 — a return is refused', async () => {
    // Sell first, while still single-branch, then open the second branch.
    const sale = await paidSale(tile, owner, 2);
    const after = await onHand(tile.productAId);
    await openSecondBranch(tile);

    await expect(returnOneUnit(tile, owner, sale.id)).rejects.toThrow(
      UnsafeMultiBranchInventoryError,
    );

    expect(await onHand(tile.productAId)).toBe(after);
    expect(await prisma.return.count()).toBe(0);
  });

  it('names the branch count and no customer data', async () => {
    await openSecondBranch(tile);
    await expect(paidSale(tile, owner, 1)).rejects.toThrow(/2 active branches/);
  });

  it('an INACTIVE second branch is not a second branch', async () => {
    await prisma.branch.create({
      data: { tenantId: tile.tenantId, name: 'Closed', code: 'CLOSED', isActive: false },
    });
    await expect(paidSale(tile, owner, 1)).resolves.toBeDefined();
  });

  it('QUICKBOOKS inventory is unaffected by a second branch', async () => {
    await giveProfile(tile, InventoryMode.QUICKBOOKS);
    await openSecondBranch(tile);
    await expect(paidSale(tile, owner, 1)).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 22-26 — DISABLED inventory
// ─────────────────────────────────────────────────────────────────────────────

describe('22-26 — DISABLED inventory', () => {
  beforeEach(async () => {
    await giveProfile(tile, InventoryMode.DISABLED, AccountingProviderKind.NONE);
  });

  it('22 — a sale far beyond on-hand completes without rejection', async () => {
    const sale = await sales.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      items: [{ productId: tile.productAId, quantity: 100_000 }],
      payments: [{ method: 'CASH', amount: 100_000_000 }],
    });
    expect(sale.status).toBe('COMPLETED');
  });

  it('23 — a sale does not reduce quantityOnHand', async () => {
    const before = await onHand(tile.productAId);
    await paidSale(tile, owner, 2);
    expect(await onHand(tile.productAId)).toBe(before);
  });

  it('24 — a return does not restore quantityOnHand', async () => {
    const before = await onHand(tile.productAId);
    const sale = await paidSale(tile, owner, 2);
    await returnOneUnit(tile, owner, sale.id);
    expect(await onHand(tile.productAId)).toBe(before);
  });

  it('25 — no inventory-related QuickBooks work is created', async () => {
    const sale = await paidSale(tile, owner, 2);
    await returnOneUnit(tile, owner, sale.id);

    expect(await prisma.syncJob.count()).toBe(0);
    expect(await prisma.syncLog.count()).toBe(0);
  });

  it('26 — the behaviour is deterministic across repeated operations', async () => {
    const before = await onHand(tile.productAId);
    for (let i = 0; i < 3; i += 1) {
      await paidSale(tile, owner, 5);
    }
    expect(await onHand(tile.productAId)).toBe(before);
    expect(await prisma.sale.count()).toBe(3);
  });

  it('26 — a second active branch is irrelevant when nothing is tracked', async () => {
    await openSecondBranch(tile);
    await expect(paidSale(tile, owner, 1)).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 27-32 — EXTERNAL, unknown modes, and isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('27-32 — fail-closed modes and isolation', () => {
  it('27 — EXTERNAL inventory refuses a sale and writes nothing', async () => {
    await giveProfile(tile, InventoryMode.EXTERNAL);
    const before = await onHand(tile.productAId);

    await expect(paidSale(tile, owner, 1)).rejects.toThrow(UnsupportedInventoryProviderError);

    expect(await onHand(tile.productAId)).toBe(before);
    expect(await prisma.sale.count()).toBe(0);
  });

  it('27 — EXTERNAL refuses a return too, and never substitutes another mode', async () => {
    const sale = await paidSale(tile, owner, 2);
    await giveProfile(tile, InventoryMode.EXTERNAL);

    await expect(returnOneUnit(tile, owner, sale.id)).rejects.toThrow(
      UnsupportedInventoryProviderError,
    );
    expect(await prisma.return.count()).toBe(0);
  });

  it('27 — EXTERNAL also refuses a draft rather than deferring the failure', async () => {
    await giveProfile(tile, InventoryMode.EXTERNAL);
    await expect(
      sales.createDraft(tile.tenantId, owner, {
        branchId: tile.branchId,
        items: [{ productId: tile.productAId, quantity: 1 }],
      }),
    ).rejects.toThrow(UnsupportedInventoryProviderError);
  });

  it('28 — an unrecognised mode fails closed through the same path', () => {
    expect(() => inventoryFactory.forMode('TELEPATHY' as InventoryMode)).toThrow(
      UnsupportedInventoryProviderError,
    );
  });

  it('29 — one tenant’s mode never resolves another tenant’s provider', async () => {
    await giveProfile(tile, InventoryMode.DISABLED, AccountingProviderKind.NONE);

    expect((await inventoryFactory.forTenant(tile.tenantId)).mode).toBe(InventoryMode.DISABLED);
    // `other` has no profile row, so it stays on the legacy QuickBooks default.
    expect((await inventoryFactory.forTenant(other.tenantId)).mode).toBe(InventoryMode.QUICKBOOKS);
  });

  it('29 — tenant B’s stock is untouched by tenant A’s DISABLED mode', async () => {
    await giveProfile(tile, InventoryMode.DISABLED, AccountingProviderKind.NONE);
    const before = await onHand(other.productAId);

    await paidSale(other, otherOwner, 2);

    expect(await onHand(other.productAId)).toBe(before - 2);
  });

  it('30/31 — the sale DTO carries neither inventoryMode nor tenantId', async () => {
    await giveProfile(tile, InventoryMode.QUICKBOOKS);
    const before = await onHand(tile.productAId);

    const sale = await sales.complete(tile.tenantId, owner, {
      branchId: tile.branchId,
      items: [{ productId: tile.productAId, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 1000 }],
      // Ignored: not declared on the DTO, and `forbidNonWhitelisted` rejects them
      // at the pipe. The service reads the mode from the authenticated tenant.
      inventoryMode: 'DISABLED',
      tenantId: other.tenantId,
    } as never);

    expect(sale.tenantId).toBe(tile.tenantId);
    expect(await onHand(tile.productAId)).toBe(before - 1);
  });

  it('32 — branch context is server-controlled: a foreign branch is refused', async () => {
    await expect(
      sales.complete(tile.tenantId, owner, {
        branchId: other.branchId,
        items: [{ productId: tile.productAId, quantity: 1 }],
        payments: [{ method: 'CASH', amount: 1000 }],
      }),
    ).rejects.toThrow();
    expect(await prisma.sale.count()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 33-42 — transactional behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('33-37 — sale rollback', () => {
  it('33-36 — a stock failure rolls back the sale, its items, payments and outbox', async () => {
    const before = await onHand(tile.productAId);
    const inventory = await inventoryFactory.forTenant(tile.tenantId);
    jest.spyOn(inventory, 'reduceStock').mockRejectedValue(new Error('stock exploded'));
    jest.spyOn(inventoryFactory, 'forTenant').mockResolvedValue(inventory);

    await expect(paidSale(tile, owner, 2)).rejects.toThrow('stock exploded');

    expect(await prisma.sale.count()).toBe(0);
    expect(await prisma.saleItem.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.syncJob.count({ where: { entityType: 'SALE' } })).toBe(0);
    expect(await prisma.syncLog.count({ where: { entityType: 'SALE' } })).toBe(0);
    expect(await onHand(tile.productAId)).toBe(before);
  });

  it('37 — an accounting failure rolls back the stock reduction', async () => {
    const before = await onHand(tile.productAId);
    const { AccountingProviderFactory } = await import(
      '../../../src/modules/providers/accounting/accounting-provider.factory'
    );
    const accountingFactory = testModule.get(AccountingProviderFactory);
    const accounting = await accountingFactory.forTenant(tile.tenantId);
    jest.spyOn(accounting, 'postSale').mockRejectedValue(new Error('accounting exploded'));
    jest.spyOn(accountingFactory, 'forTenant').mockResolvedValue(accounting);

    await expect(paidSale(tile, owner, 2)).rejects.toThrow('accounting exploded');

    // Stock reduction happens BEFORE the accounting submission in the same
    // transaction, so this is the direction that proves they share one.
    expect(await onHand(tile.productAId)).toBe(before);
    expect(await prisma.sale.count()).toBe(0);
  });
});

describe('38-41 — return rollback', () => {
  it('38-40 — a stock failure rolls back the return, its items and the refund payment', async () => {
    const sale = await paidSale(tile, owner, 2);
    const afterSale = await onHand(tile.productAId);
    const inventory = await inventoryFactory.forTenant(tile.tenantId);
    jest.spyOn(inventory, 'restoreStock').mockRejectedValue(new Error('restock exploded'));
    jest.spyOn(inventoryFactory, 'forTenant').mockResolvedValue(inventory);

    await expect(returnOneUnit(tile, owner, sale.id)).rejects.toThrow('restock exploded');

    expect(await prisma.return.count()).toBe(0);
    expect(await prisma.returnItem.count()).toBe(0);
    expect(await prisma.refundPayment.count()).toBe(0);
    expect(await prisma.syncJob.count({ where: { entityType: 'RETURN' } })).toBe(0);
    expect(await prisma.syncLog.count({ where: { entityType: 'RETURN' } })).toBe(0);
    expect(await onHand(tile.productAId)).toBe(afterSale);

    const saleRow = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(saleRow.returnStatus).toBe('NOT_RETURNED');
    expect(Number(saleRow.returnedAmount)).toBe(0);
  });

  it('41 — an accounting failure rolls back the stock restoration', async () => {
    const sale = await paidSale(tile, owner, 2);
    const afterSale = await onHand(tile.productAId);
    const { AccountingProviderFactory } = await import(
      '../../../src/modules/providers/accounting/accounting-provider.factory'
    );
    const accountingFactory = testModule.get(AccountingProviderFactory);
    const accounting = accountingFactory.forProvider(AccountingProviderKind.QUICKBOOKS);
    jest.spyOn(accounting, 'postReturn').mockRejectedValue(new Error('accounting exploded'));
    jest.spyOn(accountingFactory, 'forSale').mockReturnValue(accounting);

    await expect(returnOneUnit(tile, owner, sale.id)).rejects.toThrow('accounting exploded');

    // Restock runs before the accounting submission, so this proves the shared
    // transaction in the direction the ordering makes non-obvious.
    expect(await onHand(tile.productAId)).toBe(afterSale);
    expect(await prisma.return.count()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inventory-mode transition safety (D29)
// ─────────────────────────────────────────────────────────────────────────────

describe('inventory mode transitions', () => {
  /**
   * Slice 6C-B note: every case below sends BOTH fields. The combination validator
   * added in 6C-B refuses `LOCAL` + `QUICKBOOKS` outright, so a request that changed
   * only the mode would be rejected for the wrong reason and would stop exercising
   * the D29 transition guard at all — a vacuous test in the making.
   */
  it('a tenant with no transactions may choose any supported mode', async () => {
    await expect(
      profiles.updateProfile(
        tile.tenantId,
        dto(UpdateBusinessProfileDto, {
          businessType: 'RESTAURANT',
          inventoryMode: 'LOCAL',
          accountingProvider: 'NONE',
        }),
      ),
    ).resolves.toMatchObject({ inventoryMode: InventoryMode.LOCAL });
  });

  it.each(['LOCAL', 'DISABLED'])(
    'refuses QUICKBOOKS → %s once a completed sale exists',
    async (mode) => {
      await paidSale(tile, owner, 1);

      await expect(
        profiles.updateProfile(
          tile.tenantId,
          dto(UpdateBusinessProfileDto, { inventoryMode: mode, accountingProvider: 'NONE' }),
        ),
      ).rejects.toThrow(UnsafeInventoryModeTransitionError);

      // Unchanged: still the legacy default.
      expect((await profiles.getEffectiveProfile(tile.tenantId)).inventoryMode).toBe(
        InventoryMode.QUICKBOOKS,
      );
    },
  );

  it('refuses LOCAL → QUICKBOOKS once a completed sale exists', async () => {
    await giveProfile(tile, InventoryMode.LOCAL, AccountingProviderKind.NONE);
    await paidSale(tile, owner, 1);

    await expect(
      profiles.updateProfile(
        tile.tenantId,
        dto(UpdateBusinessProfileDto, {
          inventoryMode: 'QUICKBOOKS',
          accountingProvider: 'QUICKBOOKS',
        }),
      ),
    ).rejects.toThrow(UnsafeInventoryModeTransitionError);
  });

  it('refuses a change when only a return exists', async () => {
    const sale = await paidSale(tile, owner, 2);
    await returnOneUnit(tile, owner, sale.id);
    await prisma.sale.deleteMany({ where: { id: { not: sale.id } } });

    await expect(
      profiles.updateProfile(
        tile.tenantId,
        dto(UpdateBusinessProfileDto, { inventoryMode: 'LOCAL', accountingProvider: 'NONE' }),
      ),
    ).rejects.toThrow(UnsafeInventoryModeTransitionError);
  });

  it('allows legacy-default → explicit QUICKBOOKS, because the mode does not change', async () => {
    await paidSale(tile, owner, 1);

    const next = await profiles.updateProfile(
      tile.tenantId,
      dto(UpdateBusinessProfileDto, {
        businessType: 'HARDWARE',
        inventoryMode: 'QUICKBOOKS',
        accountingProvider: 'QUICKBOOKS',
      }),
    );

    expect(next.source).toBe('EXPLICIT');
    expect(next.inventoryMode).toBe(InventoryMode.QUICKBOOKS);
  });

  it('allows a write that omits inventoryMode entirely', async () => {
    await giveProfile(tile, InventoryMode.LOCAL, AccountingProviderKind.NONE);
    await paidSale(tile, owner, 1);

    const next = await profiles.updateProfile(
      tile.tenantId,
      dto(UpdateBusinessProfileDto, { businessType: 'CAFE' }),
    );

    expect(next.businessType).toBe(BusinessType.CAFE);
    expect(next.inventoryMode).toBe(InventoryMode.LOCAL);
  });

  it('a DRAFT sale does not lock the mode — nothing has moved yet', async () => {
    await sales.createDraft(tile.tenantId, owner, {
      branchId: tile.branchId,
      items: [{ productId: tile.productAId, quantity: 1 }],
    });

    await expect(
      profiles.updateProfile(
        tile.tenantId,
        dto(UpdateBusinessProfileDto, { inventoryMode: 'LOCAL', accountingProvider: 'NONE' }),
      ),
    ).resolves.toMatchObject({ inventoryMode: InventoryMode.LOCAL });
  });

  it('one tenant’s transactions never lock another tenant’s mode', async () => {
    await paidSale(tile, owner, 1);

    await expect(
      profiles.updateProfile(
        other.tenantId,
        dto(UpdateBusinessProfileDto, { inventoryMode: 'LOCAL', accountingProvider: 'NONE' }),
      ),
    ).resolves.toMatchObject({ inventoryMode: InventoryMode.LOCAL });
  });

  it('the refusal names counts, never customer or product data', async () => {
    await paidSale(tile, owner, 1);
    try {
      await profiles.updateProfile(
        tile.tenantId,
        dto(UpdateBusinessProfileDto, { inventoryMode: 'LOCAL', accountingProvider: 'NONE' }),
      );
      fail('expected a refusal');
    } catch (err) {
      const e = err as UnsafeInventoryModeTransitionError;
      expect(e.getStatus()).toBe(409);
      expect(e.message).toContain('QUICKBOOKS to LOCAL');
      expect(e.message).toContain('1 completed sale(s)');
      expect(e.message).not.toMatch(/token|realm|secret|Ceramic/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 43-47 — scope control
// ─────────────────────────────────────────────────────────────────────────────

describe('43-47 — Slice 6C-A changed nothing outside sale and return stock', () => {
  it('43/44 — a product created under LOCAL inventory still behaves exactly as before', async () => {
    await giveProfile(tile, InventoryMode.LOCAL, AccountingProviderKind.NONE);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });

    // Slice 6C-B's job (D28). Until then a LOCAL tenant's products still carry
    // QuickBooks fields, and this test is the tripwire for that change.
    expect(product).toHaveProperty('quickbooksItemId');
    expect(product).toHaveProperty('syncStatus');
  });

  it('45 — the inventory port has no product lifecycle operation', async () => {
    const inventory = await inventoryFactory.forTenant(tile.tenantId);
    const record = inventory as unknown as Record<string, unknown>;

    for (const method of ['createProduct', 'updateProduct', 'deactivateProduct', 'syncProducts']) {
      expect(record[method]).toBeUndefined();
    }
    // POSITIVE CONTROL (6C-A.5): the probe can see a method that IS there, so the
    // undefineds above mean "absent" rather than "probing the wrong object".
    for (const method of ['getAvailability', 'reduceStock', 'restoreStock', 'adjustStock']) {
      expect(typeof record[method]).toBe('function');
    }
  });

  it('46 — no BranchInventory model exists', () => {
    const client = prisma as unknown as Record<string, unknown>;
    expect(client.branchInventory).toBeUndefined();
    expect(client.inventoryMovement).toBeUndefined();
    expect(client.inventoryBalance).toBeUndefined();
    // POSITIVE CONTROL: the same probe finds the models that DO exist, so an
    // `undefined` above is a real absence and not a mistyped accessor.
    expect(typeof client.product).toBe('object');
    expect(typeof client.tenantBusinessProfile).toBe('object');
  });

  it('45/46 — no Restaurant domain model exists either', () => {
    const client = prisma as unknown as Record<string, unknown>;
    for (const model of [
      'restaurantOrder',
      'orderRound',
      'kitchenTicket',
      'diningArea',
      'restaurantTable',
      'menu',
      'menuItem',
    ]) {
      expect(client[model]).toBeUndefined();
    }
    expect(typeof client.sale).toBe('object');
  });

  it('quantityOnHand is still the only stock column, and still not branch-scoped', async () => {
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `select column_name from information_schema.columns
        where table_name = 'Product' and column_name ilike '%quantity%'
        order by column_name`,
    );
    // `quantityAsOfDate` is the pre-existing QuickBooks inventory-start mirror, not
    // a stock level. The point of the assertion is that no branch-scoped quantity
    // column has appeared — that is Phase 2.5, and D10 still holds.
    expect(columns.map((c) => c.column_name)).toEqual(['quantityAsOfDate', 'quantityOnHand']);
    const branchScoped = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `select table_name from information_schema.columns
        where column_name = 'branchId' and table_name ilike '%inventory%'`,
    );
    expect(branchScoped).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 6C-A.5 — runtime provider observation (approved pattern 5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Source text proves what the code *says*; these prove what it *does*.
 *
 * Every assertion here spies on the resolved provider instance and checks whether
 * the method was actually invoked, with the arguments the flow claims to pass. A
 * source-grep cannot distinguish "imports the factory" from "resolves it and then
 * ignores it", and a stock-quantity assertion cannot distinguish LOCAL from
 * QUICKBOOKS at all — which is how the two vacuous tripwires survived.
 */
describe('6C-A.5 — the provider is genuinely invoked, not merely imported', () => {
  it('sale availability goes through InventoryProvider.getAvailability', async () => {
    const inventory = await inventoryFactory.forTenant(tile.tenantId);
    const spy = jest.spyOn(inventory, 'getAvailability');
    jest.spyOn(inventoryFactory, 'forTenant').mockResolvedValue(inventory);

    await paidSale(tile, owner, 1);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      { tenantId: tile.tenantId, branchId: tile.branchId },
      [tile.productAId],
    );
  });

  it('sale stock reduction goes through InventoryProvider.reduceStock, inside the transaction', async () => {
    const inventory = await inventoryFactory.forTenant(tile.tenantId);
    const spy = jest.spyOn(inventory, 'reduceStock');
    jest.spyOn(inventoryFactory, 'forTenant').mockResolvedValue(inventory);

    await paidSale(tile, owner, 2);

    expect(spy).toHaveBeenCalledTimes(1);
    const [tx, ctx, lines] = spy.mock.calls[0];
    // A transaction client, not the root PrismaService: it has no `$transaction`.
    expect((tx as unknown as Record<string, unknown>).$transaction).toBeUndefined();
    expect(typeof (tx as unknown as Record<string, unknown>).product).toBe('object');
    expect(ctx).toEqual({ tenantId: tile.tenantId, branchId: tile.branchId });
    expect(lines).toEqual([
      {
        productId: tile.productAId,
        productName: expect.any(String),
        quantity: 2,
        trackInventory: true,
      },
    ]);
  });

  it('return stock restoration goes through InventoryProvider.restoreStock, with only eligible lines', async () => {
    const sale = await paidSale(tile, owner, 2);
    const inventory = await inventoryFactory.forTenant(tile.tenantId);
    const spy = jest.spyOn(inventory, 'restoreStock');
    jest.spyOn(inventoryFactory, 'forTenant').mockResolvedValue(inventory);

    await returnOneUnit(tile, owner, sale.id);

    expect(spy).toHaveBeenCalledTimes(1);
    const [tx, ctx, lines] = spy.mock.calls[0];
    expect((tx as unknown as Record<string, unknown>).$transaction).toBeUndefined();
    expect(ctx).toEqual({ tenantId: tile.tenantId, branchId: tile.branchId });
    expect(lines).toEqual([
      {
        productId: tile.productAId,
        productName: expect.any(String),
        quantity: 1,
        trackInventory: true,
      },
    ]);
  });

  it('an INELIGIBLE return line reaches the provider as an empty list, not as a filtered flag', async () => {
    const sale = await paidSale(tile, owner, 2);
    const inventory = await inventoryFactory.forTenant(tile.tenantId);
    const spy = jest.spyOn(inventory, 'restoreStock');
    jest.spyOn(inventoryFactory, 'forTenant').mockResolvedValue(inventory);

    await returnOneUnit(tile, owner, sale.id, {
      condition: 'DAMAGED',
      disposition: 'DAMAGED_STOCK',
      approve: true,
    });

    // Called — the seam is unconditional — but with nothing to restore, which is
    // what proves the condition/disposition rule stayed in the return domain.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toEqual([]);
  });

  it('a DISABLED tenant resolves NoInventoryProvider and it really does nothing', async () => {
    await giveProfile(tile, InventoryMode.DISABLED, AccountingProviderKind.NONE);
    const inventory = await inventoryFactory.forTenant(tile.tenantId);
    expect(inventory.mode).toBe(InventoryMode.DISABLED);

    const reduce = jest.spyOn(inventory, 'reduceStock');
    jest.spyOn(inventoryFactory, 'forTenant').mockResolvedValue(inventory);
    const before = await onHand(tile.productAId);

    await paidSale(tile, owner, 2);

    // Invoked, and had no effect — different from "never called", and only a
    // runtime observation can tell those apart.
    expect(reduce).toHaveBeenCalledTimes(1);
    expect(await onHand(tile.productAId)).toBe(before);
  });

  it('a LOCAL tenant resolves LocalInventoryProvider, not the QuickBooks one', async () => {
    await giveProfile(tile, InventoryMode.LOCAL, AccountingProviderKind.NONE);
    const inventory = await inventoryFactory.forTenant(tile.tenantId);

    expect(inventory.mode).toBe(InventoryMode.LOCAL);
    expect(inventory.name).toBe('Local inventory');
    expect(inventory.constructor.name).toBe('LocalInventoryProvider');
  });

  it('product creation still uses the existing QuickBooks product-sync path, untouched', async () => {
    const created = await prisma.product.create({
      data: {
        tenantId: tile.tenantId,
        name: 'Audit Widget',
        sku: 'AUDIT-1',
        type: 'Inventory',
        unitPrice: 100,
        quantityOnHand: 5,
      },
    });

    // The legacy enqueue path is still the one that exists, and still works.
    const job = await syncQueue.enqueueProductSync(tile.tenantId, created.id);
    expect(job).toBeDefined();
    const rows = await prisma.syncJob.findMany({
      where: { entityType: 'PRODUCT', entityId: created.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('PRODUCT_SYNC');
    expect(rows[0].direction).toBe('OUTBOUND');
    expect(rows[0].status).toBe('PENDING');
  });

  /**
   * Updated in Slice 6C-B — this tripwire fired exactly as intended.
   *
   * Written in 6C-A.5 asserting that ProductsService held NO provider factory, with
   * `CatalogSyncProviderFactory` named so the day it appeared the change had to be
   * deliberate. 6C-B is that change, so the assertion now records the new split:
   * the catalogue factory is present, the stock and accounting ones are not.
   */
  it('ProductsService holds ONLY the catalogue factory at runtime', () => {
    const products = testModule.get(ProductsService);
    const dependencies = Object.values(products as unknown as Record<string, unknown>)
      .filter((v) => v && typeof v === 'object')
      .map((v) => (v as object).constructor.name);

    expect(dependencies).toContain('CatalogSyncProviderFactory');
    expect(dependencies).not.toContain('InventoryProviderFactory');
    expect(dependencies).not.toContain('AccountingProviderFactory');
    expect(dependencies).not.toContain('SyncQueueService');
    expect(dependencies).toContain('ProductsRepository');
  });
});
