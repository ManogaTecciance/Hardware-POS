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
import { SalesService } from '../../../src/modules/sales/sales.service';
import { ReturnsModule } from '../../../src/modules/returns/returns.module';
import { ReturnsService } from '../../../src/modules/returns/returns.service';
import { CreateReturnDto } from '../../../src/modules/returns/dto/create-return.dto';
import { ApproveReturnDto } from '../../../src/modules/returns/dto/approve-return.dto';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';
import { dto } from '../dto';
import { InventoryProviderFactory } from '../../../src/modules/providers/inventory/inventory-provider.factory';
import { InvalidBranchContextError } from '../../../src/modules/providers/provider.errors';
import type { StockLine } from '../../../src/modules/providers/provider.types';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { MANAGER_PIN, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let inventoryFactory: InventoryProviderFactory;
let sales: SalesService;
let returns: ReturnsService;
let owner: AuthenticatedUser;
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
      ReturnsModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();
  inventoryFactory = testModule.get(InventoryProviderFactory);
  sales = testModule.get(SalesService);
  returns = testModule.get(ReturnsService);
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
  owner = { id: tile.ownerId, tenantId: tile.tenantId, role: 'OWNER', activeBranchId: null };
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

// ─────────────────────────────────────────────────────────────────────────────

/**
 * D99 (1c.7) — the loop closed: a completed SALE, not a provider call.
 *
 * Everything above proves `reduceStock` handles variants. None of it proves the
 * sale pipeline ever *hands* it one. Between the two sat `SaleItemInputDto`'s
 * `productVariantId?`, which is optional — omitting it compiles, validates,
 * returns 201 and quietly sells at product level. That is precisely the shape of
 * defect that has bitten this phase four times, and no type can catch it.
 *
 * So these go through `SalesService.complete` with a real cart, and assert the
 * STORED row — the only evidence that the id survived the whole pipeline.
 */
function sale(variantId: string | undefined, quantity: number) {
  return sales.complete(tile.tenantId, owner, {
    branchId: tile.branchId,
    registerId: tile.registerId,
    items: [{ productId: tile.productAId, productVariantId: variantId, quantity }],
    payments: [{ method: 'CASH', amount: 1000 * quantity }],
  });
}

async function storedLine(saleId: string) {
  return prisma.saleItem.findFirstOrThrow({ where: { saleId } });
}

describe('a completed sale carries the variant end to end (1c.7)', () => {
  it('stores the variant id on the sale line', async () => {
    const { mediumId } = await twoSizes(10, 10);

    const result = await sale(mediumId, 2);
    const line = await storedLine(result.id);

    // The assertion the compiler cannot make. If the payload field is ever
    // dropped again this is the only thing that fails.
    expect(line.productVariantId).toBe(mediumId);
    expect(line.productVariantId).not.toBeNull();
  });

  it('freezes the D44 snapshots at sale time', async () => {
    const { mediumId } = await twoSizes(10, 10);

    const result = await sale(mediumId, 1);
    const line = await storedLine(result.id);

    expect(line.variantSkuSnapshot).toBe('SHIRT-M');
    // No option values on this fixture, so the display name falls back to the
    // SKU — the documented behaviour of `variantDisplayName`, asserted rather
    // than assumed.
    expect(line.variantNameSnapshot).toBe('SHIRT-M');
  });

  it('renaming the variant afterwards does not rewrite the sale', async () => {
    const { mediumId } = await twoSizes(10, 10);
    const result = await sale(mediumId, 1);

    await prisma.productVariant.update({ where: { id: mediumId }, data: { sku: 'SHIRT-MEDIUM' } });

    // The whole reason D44 snapshots rather than joins.
    expect((await storedLine(result.id)).variantSkuSnapshot).toBe('SHIRT-M');
  });

  it('depletes the sold size and leaves its sibling untouched', async () => {
    const { mediumId, largeId } = await twoSizes(10, 10);

    await sale(mediumId, 3);

    expect(await variantQty(mediumId)).toBe(7);
    // The negative half, and the actual bug being fixed: before 1c.7 the sale
    // reached the provider with no variant, so this row moved and that one did
    // not — or a product-level number moved and neither did.
    expect(await variantQty(largeId)).toBe(10);
  });

  it('moves the D10 rollup mirror with it', async () => {
    const { mediumId } = await twoSizes(10, 10);
    const before = await productQty();

    await sale(mediumId, 2);

    expect(await productQty()).toBe(before - 2);
  });

  it('refuses to oversell the chosen size, and moves nothing when it does', async () => {
    const { mediumId, largeId } = await twoSizes(2, 10);

    await expect(sale(mediumId, 3)).rejects.toThrow();

    // The guard is only worth having if the failure is atomic. A partial write
    // here would leave stock short with no sale to account for it.
    expect(await variantQty(mediumId)).toBe(2);
    expect(await variantQty(largeId)).toBe(10);
  });

  it('a sibling with plenty of stock does not rescue an oversold size', async () => {
    // Product-level depletion would have seen 12 units across the two rows and
    // happily sold 3 Mediums out of 2.
    const { mediumId } = await twoSizes(2, 10);

    await expect(sale(mediumId, 3)).rejects.toThrow();
  });
});

describe('omitting the variant is still a valid product-level sale', () => {
  it('stores a null variant id and touches no variant row', async () => {
    // Loose goods, a service, a single-SKU product — and every sale in history.
    // This is the control that proves the assertions above are about the id
    // being SENT, not about variants existing in the database.
    const { mediumId, largeId } = await twoSizes(10, 10);

    const result = await sale(undefined, 1);
    const line = await storedLine(result.id);

    expect(line.productVariantId).toBeNull();
    expect(line.variantSkuSnapshot).toBeNull();
    expect(await variantQty(mediumId)).toBe(10);
    expect(await variantQty(largeId)).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * D99 (1a.20) — a return puts stock back on the SIZE that was sold.
 *
 * `restoreStock` aggregated by product alone and touched `Product.quantityOnHand`
 * only, which made the two paths asymmetric for a variant line:
 *
 *   sale    → BranchInventory(variant) decremented, Product mirrored
 *   return  → Product incremented, BranchInventory NEVER touched
 *
 * So a returned Medium credited the customer, bumped the product total, and never
 * went back on the shelf. The variant row stayed down and the mirror drifted up a
 * little further with every return.
 *
 * The variant is not taken from the caller. `ReturnItemInputDto` names a
 * `saleItemId`, so the server reads the size off its own historical record — a
 * client cannot restock a Large against a sale of a Medium, because it is never
 * asked which size is coming back.
 */
function returnLine(saleItemId: string, quantity: number, over: Record<string, unknown> = {}) {
  return {
    saleItemId,
    returnQuantity: quantity,
    returnReason: 'CHANGED_MIND',
    itemCondition: 'GOOD',
    stockDisposition: 'RETURN_TO_STOCK',
    ...over,
  };
}

async function returnFrom(
  saleId: string,
  items: Record<string, unknown>[],
  { approve = false, refundTotal = 1000 }: { approve?: boolean; refundTotal?: number } = {},
) {
  // A damaged or non-resellable return needs a manager, which is a real rule —
  // obeyed here rather than bypassed, so the test exercises the same path a
  // cashier walks.
  let approvalToken: string | undefined;
  if (approve) {
    const approval = await returns.approve(
      tile.tenantId,
      dto(ApproveReturnDto, { managerPin: MANAGER_PIN, originalSaleId: saleId, refundTotal }),
    );
    if (!approval.approved || !approval.approvalToken) {
      throw new Error(`Fixture approval refused: ${approval.reason ?? 'unknown'}`);
    }
    approvalToken = approval.approvalToken;
  }

  return returns.complete(
    tile.tenantId,
    owner,
    dto(CreateReturnDto, {
      originalSaleId: saleId,
      refundMethod: 'CASH',
      ...(approvalToken ? { approvalToken } : {}),
      items,
    }),
    null,
  );
}

async function soldMedium(qty: number) {
  const { mediumId, largeId } = await twoSizes(10, 10);
  const result = await sale(mediumId, qty);
  const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: result.id } });
  return { mediumId, largeId, saleId: result.id, saleItemId: saleItem.id };
}

describe('a return restocks the variant that was sold (1a.20)', () => {
  it('puts the quantity back on the sold size and leaves its sibling alone', async () => {
    const { mediumId, largeId, saleId, saleItemId } = await soldMedium(3);
    expect(await variantQty(mediumId)).toBe(7);

    await returnFrom(saleId, [returnLine(saleItemId, 2)]);

    expect(await variantQty(mediumId)).toBe(9);
    // The negative half, and the whole bug: restocking by product alone put the
    // units into a number that is not this row, so this stayed at 7 forever.
    expect(await variantQty(largeId)).toBe(10);
  });

  it('moves the D10 rollup mirror back with it, exactly once', async () => {
    const { saleId, saleItemId } = await soldMedium(3);
    const afterSale = await productQty();

    await returnFrom(saleId, [returnLine(saleItemId, 2)]);

    // "Exactly once" matters: the variant branch increments BranchInventory and
    // then mirrors onto Product. Incrementing the product twice — once in each
    // branch — is the obvious way to write this wrong.
    expect(await productQty()).toBe(afterSale + 2);
  });

  it('stores the variant id and both D44 snapshots on the return line', async () => {
    const { mediumId, saleId, saleItemId } = await soldMedium(2);

    const ret = await returnFrom(saleId, [returnLine(saleItemId, 1)]);
    const line = await prisma.returnItem.findFirstOrThrow({ where: { returnId: ret.id } });

    // These three columns have existed since D44 and were never written. The
    // stored row is the only evidence they are now populated.
    expect(line.productVariantId).toBe(mediumId);
    expect(line.variantSkuSnapshot).toBe('SHIRT-M');
    expect(line.variantNameSnapshot).toBe('SHIRT-M');
  });

  it('takes the size from the SALE, so a rename between sale and return changes nothing', async () => {
    const { mediumId, saleId, saleItemId } = await soldMedium(2);

    await prisma.productVariant.update({ where: { id: mediumId }, data: { sku: 'SHIRT-MEDIUM' } });
    const ret = await returnFrom(saleId, [returnLine(saleItemId, 1)]);
    const line = await prisma.returnItem.findFirstOrThrow({ where: { returnId: ret.id } });

    // Copied from the sale's frozen snapshot, never re-derived from the live
    // variant — the reason D44 snapshots rather than joins.
    expect(line.variantSkuSnapshot).toBe('SHIRT-M');
    // The stock still goes back to the right row: the id is what moves stock,
    // and renaming does not change identity.
    expect(await variantQty(mediumId)).toBe(9);
  });
});

describe('return eligibility still decides whether stock moves at all', () => {
  it('does not restock a DAMAGED item, even though it now names a variant', async () => {
    const { mediumId, saleId, saleItemId } = await soldMedium(3);

    await returnFrom(
      saleId,
      [returnLine(saleItemId, 2, { itemCondition: 'DAMAGED', stockDisposition: 'DAMAGED_STOCK' })],
      { approve: true, refundTotal: 2000 },
    );

    // Threading the variant through must not sneak past the eligibility filter:
    // damaged goods are refunded but never resold.
    expect(await variantQty(mediumId)).toBe(7);
  });

  it('does not restock when the disposition is not RETURN_TO_STOCK', async () => {
    const { mediumId, saleId, saleItemId } = await soldMedium(3);

    await returnFrom(saleId, [returnLine(saleItemId, 2, { stockDisposition: 'DO_NOT_RESTOCK' })]);

    expect(await variantQty(mediumId)).toBe(7);
  });
});

describe('the missing-row case (1a.20 option A — upsert)', () => {
  it('creates the row rather than losing stock a cashier is holding', async () => {
    const { mediumId, saleId, saleItemId } = await soldMedium(3);

    // The row should always exist — `reduceStock` refuses a variant without one,
    // so a completed sale proves it was there. This simulates it being deleted
    // between the sale and the return.
    await prisma.branchInventory.deleteMany({ where: { productVariantId: mediumId } });

    await returnFrom(saleId, [returnLine(saleItemId, 2)]);

    // A no-op updateMany would have silently discarded two physical items.
    expect(await variantQty(mediumId)).toBe(2);
  });
});

describe('product-level returns are unchanged (regression guard)', () => {
  it('restocks the product column and touches no variant row', async () => {
    // Every existing tenant. If this moves, 1a.20 broke returns for everyone who
    // does not use variants.
    const { mediumId, largeId } = await twoSizes(10, 10);
    const result = await sale(undefined, 2);
    const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId: result.id } });
    const afterSale = await productQty();

    await returnFrom(result.id, [returnLine(saleItem.id, 1)]);

    expect(await productQty()).toBe(afterSale + 1);
    expect(await variantQty(mediumId)).toBe(10);
    expect(await variantQty(largeId)).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * D44 / D99 (1a.21) — the append-only stock ledger for retail.
 *
 * Stock levels were already correct in both directions after 1a.20. What was
 * missing was the record of WHY a number moved: a shop could see a size go
 * 3 → 1 → 2 with nothing saying which sale or return did it. Receipts have
 * written `StockMovement` since D44; sales and returns wrote nothing.
 *
 * The movement is written INSIDE the provider, in the same loop iteration as the
 * balance write. That placement is not incidental — `restoreStock` carries a
 * `type: 'Inventory'` predicate, so a SERVICE product matches zero rows and no
 * stock moves; a separate pass reading balances afterwards could not tell, and
 * would log a movement that never happened.
 */
async function movements(where: Record<string, unknown> = {}) {
  return prisma.stockMovement.findMany({
    where: { tenantId: tile.tenantId, ...where },
    orderBy: { createdAt: 'asc' },
  });
}

describe('a sale appends to the stock ledger (1a.21)', () => {
  it('records the size sold, the delta and the resulting balance', async () => {
    const { mediumId } = await twoSizes(10, 10);

    const result = await sale(mediumId, 3);
    const [row, ...rest] = await movements({ productVariantId: mediumId });

    expect(rest).toEqual([]);
    expect(Number(row!.delta)).toBe(-3);
    expect(Number(row!.balanceAfter)).toBe(7);
    expect(row!.reason).toBe('SALE');
    expect(row!.refType).toBe('SALE');
    expect(row!.refId).toBe(result.id);
    expect(row!.createdByUserId).toBe(tile.ownerId);
  });

  it('writes nothing against a sibling size', async () => {
    const { mediumId, largeId } = await twoSizes(10, 10);

    await sale(mediumId, 3);

    // The negative half. A product-keyed ledger would have attributed the
    // movement to something that is not this row.
    expect(await movements({ productVariantId: largeId })).toEqual([]);
  });

  it('records a product-level sale with an explicit null variant', async () => {
    await twoSizes(10, 10);

    await sale(undefined, 2);
    const rows = await movements({ productVariantId: null });

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.delta)).toBe(-2);
    // Present and null, not omitted — a legacy line is still a ledger entry.
    expect(rows[0]!.productVariantId).toBeNull();
  });

  it('writes no movement when the sale is refused', async () => {
    const { mediumId } = await twoSizes(2, 10);

    await expect(sale(mediumId, 3)).rejects.toThrow();

    // The whole transaction rolls back. A ledger that recorded attempts rather
    // than movements would not reconcile against the shelf.
    expect(await movements()).toEqual([]);
  });
});

describe('a return appends the counterpart entry', () => {
  it('records the restock as a positive delta against the same size', async () => {
    const { mediumId, saleId, saleItemId } = await soldMedium(3);

    const ret = await returnFrom(saleId, [returnLine(saleItemId, 2)]);
    const rows = await movements({ productVariantId: mediumId });

    expect(rows).toHaveLength(2);
    expect(Number(rows[1]!.delta)).toBe(2);
    expect(Number(rows[1]!.balanceAfter)).toBe(9);
    expect(rows[1]!.reason).toBe('RETURN');
    expect(rows[1]!.refId).toBe(ret.id);
  });

  it('the ledger reconciles to the shelf', async () => {
    // The property that makes this a ledger rather than decoration: replaying
    // every delta from the opening balance must land on the current quantity.
    const { mediumId, saleId, saleItemId } = await soldMedium(3);
    await returnFrom(saleId, [returnLine(saleItemId, 2)]);

    const rows = await movements({ productVariantId: mediumId });
    const net = rows.reduce((sum, r) => sum + Number(r.delta), 0);

    expect(10 + net).toBe(await variantQty(mediumId));
  });

  it('writes no movement for a DAMAGED return that does not restock', async () => {
    const { mediumId, saleId, saleItemId } = await soldMedium(3);

    await returnFrom(
      saleId,
      [returnLine(saleItemId, 2, { itemCondition: 'DAMAGED', stockDisposition: 'DAMAGED_STOCK' })],
      { approve: true, refundTotal: 2000 },
    );

    // Refunded but not resold. No stock moved, so the ledger must not claim it
    // did — only the SALE row from the original sale remains.
    const rows = await movements({ productVariantId: mediumId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('SALE');
  });
});

describe('the restaurant module keeps its own ledger (1a.21 constraint)', () => {
  it('a reduceStock call with NO metadata writes no movement', async () => {
    // This is `RoundDepletionService`'s exact call shape — three arguments, no
    // metadata — asserted from the retail side so that its behaviour is pinned
    // WITHOUT editing or importing any restaurant code.
    //
    // Omitting metadata means "I keep my own ledger": round-depletion writes its
    // own ORDER_ROUND rows in the caller, and a second row from the provider
    // would double-count every dish sent to a kitchen.
    //
    // If anyone later makes the parameter required, or writes unconditionally,
    // this fails here — before it can reach the restaurant module.
    const { mediumId } = await twoSizes(10, 10);

    await reduce([variantLine(mediumId, 2)]);

    expect(await variantQty(mediumId)).toBe(8);
    expect(await movements()).toEqual([]);
  });

  it('the same call WITH metadata does write one', async () => {
    // The positive half: the guard above must fail for the right reason — the
    // absent metadata — and not because movements are broken everywhere.
    const { mediumId } = await twoSizes(10, 10);
    const inventory = await inventoryFactory.forTenant(tile.tenantId);

    await prisma.$transaction((tx) =>
      inventory.reduceStock(tx, { tenantId: tile.tenantId, branchId: tile.branchId }, [variantLine(mediumId, 2)], {
        reason: 'SALE',
        refType: 'SALE',
        refId: 'sale_probe',
        createdByUserId: tile.ownerId,
      }),
    );

    const rows = await movements();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refId).toBe('sale_probe');
  });
});
