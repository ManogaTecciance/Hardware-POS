/**
 * `8.8` — hold and resume a sale.
 *
 * ## What this is, and is not
 *
 * A hold IS a draft. `SaleStatus.DRAFT` and `createDraft` have existed since
 * Phase 1 with nothing on top of them: nothing listed drafts, nothing discarded
 * one, and `complete({ saleId })` — the resume — had no caller anywhere in the
 * web app. So the properties worth proving here are not "a draft can be created"
 * (Phase 1 proved that) but the three that make it a FLOW:
 *
 *  • a held basket moves no stock while it is held, and moves it on resume,
 *  • a resumed basket is completed once and stops being held,
 *  • discarding is safe: it can never reach a completed sale.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The stock assertions are made at three points — before, while held, after
 * resume — so "stock is right at the end" cannot pass for an implementation that
 * depleted at hold time and again at completion. The discard safety property is
 * asserted POSITIVELY (a draft is discarded) and NEGATIVELY (a completed sale
 * with a valid id is not), because either alone would pass for a delete that did
 * nothing at all.
 */

import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import {
  AccountingProviderKind,
  BusinessType,
  InventoryMode,
  type PrismaClient,
} from '@hardware-pos/database';

import { validateEnv } from '../../../src/config/env.validation';
import { StorageModule } from '../../../src/common/storage/storage.module';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { PlatformModule } from '../../../src/modules/platform/platform.module';
import { ProvidersModule } from '../../../src/modules/providers/providers.module';
import { ProductsModule } from '../../../src/modules/products/products.module';
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { SalesService } from '../../../src/modules/sales/sales.service';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let sales: SalesService;
let shop: SeededTenant;
let owner: { id: string; tenantId: string; role: string; activeBranchId: string | null };

beforeAll(async () => {
  prisma = await connectTestPrisma();
  testModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      StorageModule,
      PrismaModule,
      PlatformModule,
      ProvidersModule,
      SalesModule,
      ProductsModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();
  sales = testModule.get(SalesService);
});

afterAll(async () => {
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  shop = await seedTileShopWithQuickBooks(prisma);
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: shop.tenantId,
      businessType: BusinessType.RETAIL,
      inventoryMode: InventoryMode.LOCAL,
      accountingProvider: AccountingProviderKind.NONE,
    },
  });
  owner = { id: shop.ownerId, tenantId: shop.tenantId, role: 'OWNER', activeBranchId: null };
});

/** Product A's on-hand — the fixture starts it at 100. */
async function onHand(): Promise<number> {
  const p = await prisma.product.findUniqueOrThrow({ where: { id: shop.productAId } });
  return Number(p.quantityOnHand);
}

function hold(quantity = 2) {
  return sales.createDraft(shop.tenantId, owner as never, {
    branchId: shop.branchId,
    registerId: shop.registerId,
    items: [{ productId: shop.productAId, quantity }],
  } as never);
}

describe('holding a basket', () => {
  it('moves no stock while it is held, and moves it on resume', async () => {
    expect(await onHand()).toBe(100);

    const held = await hold(2);
    expect(held.status).toBe('DRAFT');
    // The point of a hold: the goods are still on the shelf and sellable to
    // whoever walks in next. Asserted HERE, not only at the end — an
    // implementation that depleted at hold time and again at completion would
    // still finish at 98.
    expect(await onHand()).toBe(100);

    await sales.complete(shop.tenantId, owner as never, {
      saleId: held.id,
      branchId: shop.branchId,
      payments: [{ method: 'CASH', amount: 2000 }],
    } as never);

    expect(await onHand()).toBe(98);
  });

  it('appears in the held list, and leaves it once completed', async () => {
    const held = await hold();

    const before = await sales.listHeld(shop.tenantId);
    expect(before.map((s) => s.id)).toEqual([held.id]);

    await sales.complete(shop.tenantId, owner as never, {
      saleId: held.id,
      branchId: shop.branchId,
      payments: [{ method: 'CASH', amount: 2000 }],
    } as never);

    // The same sale, now completed. It must not still read as held — a basket
    // that stayed in the list after being paid for would be resumed twice.
    const after = await sales.listHeld(shop.tenantId);
    expect(after).toEqual([]);
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: held.id } });
    expect(sale.status).toBe('COMPLETED');
  });

  it('cannot be resumed twice', async () => {
    const held = await hold();
    await sales.complete(shop.tenantId, owner as never, {
      saleId: held.id,
      branchId: shop.branchId,
      payments: [{ method: 'CASH', amount: 2000 }],
    } as never);

    await expect(
      sales.complete(shop.tenantId, owner as never, {
        saleId: held.id,
        branchId: shop.branchId,
        payments: [{ method: 'CASH', amount: 2000 }],
      } as never),
    ).rejects.toThrow();

    // And the stock moved exactly once, which is what the refusal is protecting.
    expect(await onHand()).toBe(98);
  });

  it('lists newest first', async () => {
    const first = await hold(1);
    const second = await hold(2);
    const list = await sales.listHeld(shop.tenantId);
    expect(list.map((s) => s.id)).toEqual([second.id, first.id]);
  });

  it('filters to one branch — a basket belongs to the till it was put down at', async () => {
    // Held FIRST, second branch after: `createDraft` reads availability through
    // `LocalInventoryProvider`, which refuses a multi-branch LOCAL tenant
    // outright (D10's Phase 2.5 is still outstanding). Reversing these two lines
    // fails on that guard rather than on the filter this test is about.
    const here = await hold();
    const other = await prisma.branch.create({
      data: { tenantId: shop.tenantId, name: 'Second Branch', code: 'BR2' },
    });

    expect((await sales.listHeld(shop.tenantId, shop.branchId)).map((s) => s.id)).toEqual([here.id]);
    // NEGATIVE: the other branch has none. Without this the filter could be
    // ignored entirely and the assertion above would still pass.
    expect(await sales.listHeld(shop.tenantId, other.id)).toEqual([]);
  });

  it('is scoped to the tenant', async () => {
    await hold();
    expect(await sales.listHeld('some-other-tenant')).toEqual([]);
  });
});

describe('discarding a held basket', () => {
  it('removes it, and it stops being held', async () => {
    const held = await hold();
    await sales.discardHeld(shop.tenantId, held.id);

    expect(await sales.listHeld(shop.tenantId)).toEqual([]);
    expect(await prisma.sale.findUnique({ where: { id: held.id } })).toBeNull();
    // Nothing to unwind: a draft never moved stock in the first place.
    expect(await onHand()).toBe(100);
  });

  it('cannot reach a COMPLETED sale, even with its real id', async () => {
    const sale = await sales.complete(shop.tenantId, owner as never, {
      branchId: shop.branchId,
      registerId: shop.registerId,
      items: [{ productId: shop.productAId, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 1000 }],
    } as never);

    await expect(sales.discardHeld(shop.tenantId, sale.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // The sale is untouched. This is the assertion that makes the delete safe:
    // the predicate, not the caller, is what refuses.
    const still = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(still.status).toBe('COMPLETED');
    expect(await prisma.saleItem.count({ where: { saleId: sale.id } })).toBe(1);
  });

  it('cannot reach another tenant’s held basket', async () => {
    const held = await hold();
    await expect(sales.discardHeld('some-other-tenant', held.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await prisma.sale.findUnique({ where: { id: held.id } })).not.toBeNull();
  });

  it('reports an unknown id rather than succeeding silently', async () => {
    await expect(sales.discardHeld(shop.tenantId, 'no-such-sale')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
