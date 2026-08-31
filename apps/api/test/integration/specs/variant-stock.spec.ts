/**
 * D99 — variant-level stock depletion, against real PostgreSQL.
 *
 * Goods receipts have written `BranchInventory` per (branch, product, variant)
 * since D44. Selling could not name a variant, so a sale reduced one product-level
 * number and left those rows untouched: per-size stock was correct the moment goods
 * arrived and wrong the moment anything sold.
 *
 * What can only be proven here, not in a unit spec:
 *
 *  • the conditional write still serialises two concurrent sales of the last unit —
 *    a mocked client would let both succeed and tell us nothing;
 *  • that the concurrency test is not vacuous. The mutation proof at the end runs
 *    the same race against a deliberately unguarded write and shows it oversells,
 *    so a future edit that weakens the predicate cannot pass silently (D30);
 *  • the D10 rollup mirror moves with the variant row, since a drifting product
 *    total is invisible until someone reads the product list.
 *
 * Variants are built here rather than in `fixtures.ts`: the shared fixtures are
 * consumed by every other spec, and none of them wants a variant dimension.
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
import { PlatformModule } from '../../../src/modules/platform/platform.module';
import { ProvidersModule } from '../../../src/modules/providers/providers.module';
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { InventoryProviderFactory } from '../../../src/modules/providers/inventory/inventory-provider.factory';
import { InvalidBranchContextError } from '../../../src/modules/providers/provider.errors';
import type { StockLine } from '../../../src/modules/providers/provider.types';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let inventoryFactory: InventoryProviderFactory;
let tile: SeededTenant;

/** A shirt in two sizes, each with its own branch stock row. */
interface TwoSizes {
  mediumId: string;
  largeId: string;
}

beforeAll(async () => {
  prisma = await connectTestPrisma();
  testModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      StorageModule,
      PrismaModule,
      PlatformModule,
      ProvidersModule,
      // ProvidersModule reaches QuickBooksModule, which needs JwtService.
      // SalesModule supplies it transitively — the same graph `providers.spec`
      // and `inventory-adoption.spec` compile.
      SalesModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();
  inventoryFactory = testModule.get(InventoryProviderFactory);
});

afterAll(async () => {
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tile = await seedTileShopWithQuickBooks(prisma);
  // LOCAL is the retail posture (D99): the tenant owns its own stock numbers.
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: tile.tenantId,
      businessType: BusinessType.HARDWARE,
      inventoryMode: InventoryMode.LOCAL,
      accountingProvider: AccountingProviderKind.NONE,
    },
  });
});

/**
 * Two variants of `productAId`, each with its own `BranchInventory` row.
 *
 * Written straight to the database rather than through the receive path, so a
 * failure here is a depletion failure and never a receiving one.
 */
async function twoSizes(mediumQty: number, largeQty: number): Promise<TwoSizes> {
  const mk = async (sku: string, qty: number): Promise<string> => {
    const variant = await prisma.productVariant.create({
      data: {
        tenantId: tile.tenantId,
        productId: tile.productAId,
        sku,
        unitPrice: 1000,
      },
    });
    await prisma.branchInventory.create({
      data: {
        tenantId: tile.tenantId,
        branchId: tile.branchId,
        productId: tile.productAId,
        productVariantId: variant.id,
        quantityOnHand: qty,
      },
    });
    return variant.id;
  };
  return { mediumId: await mk('SHIRT-M', mediumQty), largeId: await mk('SHIRT-L', largeQty) };
}

function variantLine(variantId: string, quantity: number, name = 'Shirt'): StockLine {
  return {
    productId: tile.productAId,
    productVariantId: variantId,
    productName: name,
    quantity,
    trackInventory: true,
  };
}

async function variantQty(variantId: string): Promise<number> {
  const row = await prisma.branchInventory.findFirstOrThrow({
    where: { branchId: tile.branchId, productVariantId: variantId },
  });
  return Number(row.quantityOnHand);
}

async function productQty(): Promise<number> {
  const p = await prisma.product.findUniqueOrThrow({ where: { id: tile.productAId } });
  return Number(p.quantityOnHand);
}

async function reduce(lines: StockLine[], branchId: string | null = tile.branchId): Promise<void> {
  const inventory = await inventoryFactory.forTenant(tile.tenantId);
  await prisma.$transaction((tx) =>
    inventory.reduceStock(tx, { tenantId: tile.tenantId, branchId }, lines),
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe('a sale reduces the variant that was actually sold', () => {
  it('decrements the sold variant and leaves its siblings alone', async () => {
    const { mediumId, largeId } = await twoSizes(10, 10);

    await reduce([variantLine(mediumId, 3)]);

    expect(await variantQty(mediumId)).toBe(7);
    // The whole point: selling a Medium must not touch the Large.
    expect(await variantQty(largeId)).toBe(10);
  });

  it('moves the D10 rollup mirror with it', async () => {
    const { mediumId } = await twoSizes(10, 10);
    const before = await productQty();

    await reduce([variantLine(mediumId, 4)]);

    // `receiveStock` increments this column; if a sale did not decrement it, the
    // product total would only ever climb and the low-stock badge would lie.
    expect(await productQty()).toBe(before - 4);
  });

  it('aggregates repeated lines of the SAME variant into one decrement', async () => {
    const { mediumId } = await twoSizes(10, 10);

    await reduce([variantLine(mediumId, 2), variantLine(mediumId, 3)]);

    expect(await variantQty(mediumId)).toBe(5);
  });

  it('keeps two different variants of one product as two separate decrements', async () => {
    const { mediumId, largeId } = await twoSizes(10, 10);

    await reduce([variantLine(mediumId, 2), variantLine(largeId, 5)]);

    // Aggregating by product alone would have taken 7 from a single row.
    expect(await variantQty(mediumId)).toBe(8);
    expect(await variantQty(largeId)).toBe(5);
  });

  it('never moves stock for an untracked line', async () => {
    const { mediumId } = await twoSizes(10, 10);

    await reduce([{ ...variantLine(mediumId, 5), trackInventory: false }]);

    expect(await variantQty(mediumId)).toBe(10);
  });
});

describe('refusals', () => {
  it('refuses to oversell a variant, with the same wording as the product path', async () => {
    const { mediumId } = await twoSizes(2, 10);

    await expect(reduce([variantLine(mediumId, 3)])).rejects.toThrow(
      'Insufficient stock for Shirt',
    );
    expect(await variantQty(mediumId)).toBe(2);
  });

  it('refuses a variant that was never received into this branch (D99 decision 8)', async () => {
    // A variant with no BranchInventory row has no stock — receipts create stock,
    // sales never do. The conditional write matches nothing and reports it as such.
    const orphan = await prisma.productVariant.create({
      data: { tenantId: tile.tenantId, productId: tile.productAId, sku: 'SHIRT-XL', unitPrice: 1000 },
    });

    await expect(reduce([variantLine(orphan.id, 1)])).rejects.toThrow(
      'Insufficient stock for Shirt',
    );
  });

  it('refuses a variant line with no branch context (D99 decision 9)', async () => {
    const { mediumId } = await twoSizes(10, 10);

    // A variant's stock is branch-scoped, so there is no row to target. Failing
    // loudly matches `receiveStock`; falling back to product level would hide the
    // caller's omission and silently move the wrong number.
    await expect(reduce([variantLine(mediumId, 1)], null)).rejects.toThrow(
      InvalidBranchContextError,
    );
    expect(await variantQty(mediumId)).toBe(10);
  });

  it('a rejected variant line writes nothing at all', async () => {
    const { mediumId, largeId } = await twoSizes(1, 10);
    const productBefore = await productQty();

    // The Large is fine; the Medium is short. The whole transaction must roll back.
    await expect(reduce([variantLine(largeId, 1), variantLine(mediumId, 5)])).rejects.toThrow();

    expect(await variantQty(mediumId)).toBe(1);
    expect(await variantQty(largeId)).toBe(10);
    expect(await productQty()).toBe(productBefore);
  });
});

describe('product-level behaviour is unchanged', () => {
  it('a line with no variant still decrements the product column', async () => {
    const before = await productQty();

    await reduce([
      {
        productId: tile.productAId,
        productVariantId: null,
        productName: 'Tile',
        quantity: 5,
        trackInventory: true,
      },
    ]);

    expect(await productQty()).toBe(before - 5);
  });

  it('a product-level line does NOT require a branch context', async () => {
    const before = await productQty();

    // Only variant lines need a branch: this is what keeps every pre-variant
    // caller working exactly as it did.
    await reduce(
      [
        {
          productId: tile.productAId,
          productVariantId: null,
          productName: 'Tile',
          quantity: 1,
          trackInventory: true,
        },
      ],
      null,
    );

    expect(await productQty()).toBe(before - 1);
  });
});

describe('the oversell guard under concurrency', () => {
  /**
   * Both transactions read a quantity of 1 before either writes. Only the
   * conditional predicate inside the write can decide between them.
   */
  async function raceForTheLastOne(variantId: string) {
    const results = await Promise.allSettled([
      reduce([variantLine(variantId, 1)]),
      reduce([variantLine(variantId, 1)]),
    ]);
    return {
      fulfilled: results.filter((r) => r.status === 'fulfilled').length,
      left: await variantQty(variantId),
    };
  }

  it('two concurrent sales cannot both take the last unit of a variant', async () => {
    const { mediumId } = await twoSizes(1, 10);

    const { fulfilled, left } = await raceForTheLastOne(mediumId);

    expect(fulfilled).toBe(1);
    expect(left).toBe(0);
  });

  /**
   * MUTATION PROOF (D30).
   *
   * The test above passes today. It would also pass against a broken guard if the
   * race never actually collided — in which case it would be a tripwire that
   * asserts nothing, which D30 calls worse than no test at all.
   *
   * So run the identical race against a deliberately UNGUARDED write — the same
   * SQL with `quantityOnHand: { gte: qty }` removed — and prove it oversells. That
   * the two outcomes differ is what makes the assertion above meaningful: it is
   * the predicate doing the work, not the timing.
   */
  it('MUTATION PROOF — the same race oversells once the `gte` predicate is removed', async () => {
    const { mediumId } = await twoSizes(1, 10);

    const unguardedReduce = async (): Promise<void> => {
      await prisma.$transaction(async (tx) => {
        await tx.branchInventory.updateMany({
          where: {
            tenantId: tile.tenantId,
            branchId: tile.branchId,
            productVariantId: mediumId,
            // quantityOnHand: { gte: 1 }  ← the mutation: guard removed
          },
          data: { quantityOnHand: { decrement: 1 }, version: { increment: 1 } },
        });
      });
    };

    const results = await Promise.allSettled([unguardedReduce(), unguardedReduce()]);

    // Both succeed, and the row goes negative: one unit sold twice.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await variantQty(mediumId)).toBe(-1);
  });
});

describe('read-time availability agrees with the write guard (1a.19)', () => {
  /**
   * The defect this closes: the product total is the sum across every size, so a
   * product with 10 Larges and 0 Mediums passed the read check for a Medium and was
   * then refused by the write. Two messages for one condition, and the terser one.
   */
  async function attemptSale(variantId: string, quantity: number): Promise<string> {
    try {
      await reduce([variantLine(variantId, quantity)]);
      return '<<no error>>';
    } catch (err) {
      return (err as Error).message;
    }
  }

  it('reports the variant out of stock at read time, naming the size', async () => {
    const { mediumId } = await twoSizes(0, 10);
    const inventory = await inventoryFactory.forTenant(tile.tenantId);

    const map = await inventory.getVariantAvailability!(
      { tenantId: tile.tenantId, branchId: tile.branchId },
      [mediumId],
    );

    expect(map.get(mediumId)?.quantityOnHand).toBe(0);
  });

  it('omits a variant with no BranchInventory row, which the caller reads as zero', async () => {
    const orphan = await prisma.productVariant.create({
      data: { tenantId: tile.tenantId, productId: tile.productAId, sku: 'SHIRT-XXL', unitPrice: 1000 },
    });
    const inventory = await inventoryFactory.forTenant(tile.tenantId);

    const map = await inventory.getVariantAvailability!(
      { tenantId: tile.tenantId, branchId: tile.branchId },
      [orphan.id],
    );

    // Absent, not zero — the same contract getAvailability uses for an unknown
    // product. Distinguishing "no row" from "zero on hand" is the caller's choice.
    expect(map.has(orphan.id)).toBe(false);
  });

  it('reads one variant without reporting on its siblings', async () => {
    const { mediumId, largeId } = await twoSizes(3, 7);
    const inventory = await inventoryFactory.forTenant(tile.tenantId);

    const map = await inventory.getVariantAvailability!(
      { tenantId: tile.tenantId, branchId: tile.branchId },
      [mediumId],
    );

    expect(map.get(mediumId)?.quantityOnHand).toBe(3);
    expect(map.has(largeId)).toBe(false);
  });

  it('returns an empty map with no branch context rather than throwing', async () => {
    const { mediumId } = await twoSizes(5, 5);
    const inventory = await inventoryFactory.forTenant(tile.tenantId);

    // A read must not become a second gate: reduceStock already refuses a variant
    // line with no branch, and that is where the failure belongs.
    const map = await inventory.getVariantAvailability!(
      { tenantId: tile.tenantId, branchId: null },
      [mediumId],
    );

    expect(map.size).toBe(0);
  });

  it('the read and the write agree that an empty variant is empty', async () => {
    const { mediumId } = await twoSizes(0, 10);
    const inventory = await inventoryFactory.forTenant(tile.tenantId);

    const map = await inventory.getVariantAvailability!(
      { tenantId: tile.tenantId, branchId: tile.branchId },
      [mediumId],
    );
    const readSaysEmpty = (map.get(mediumId)?.quantityOnHand ?? 0) === 0;
    const writeMessage = await attemptSale(mediumId, 1);

    // Before this step the read said "10 available" while the write refused.
    expect(readSaysEmpty).toBe(true);
    expect(writeMessage).toContain('Insufficient stock');
  });
});
