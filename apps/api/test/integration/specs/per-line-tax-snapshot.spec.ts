import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@hardware-pos/database';

import { validateEnv } from '../../../src/config/env.validation';
import { StorageModule } from '../../../src/common/storage/storage.module';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { PlatformModule } from '../../../src/modules/platform/platform.module';
import { ProvidersModule } from '../../../src/modules/providers/providers.module';
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { SalesService } from '../../../src/modules/sales/sales.service';
import { ProductsModule } from '../../../src/modules/products/products.module';
import { ProductsService } from '../../../src/modules/products/products.service';
import { CreateProductDto } from '../../../src/modules/products/dto/create-product.dto';
import { UpdateProductDto } from '../../../src/modules/products/dto/update-product.dto';
import { ReturnsModule } from '../../../src/modules/returns/returns.module';
import { ReturnsService } from '../../../src/modules/returns/returns.service';
import { CreateReturnDto } from '../../../src/modules/returns/dto/create-return.dto';
import { ApproveReturnDto } from '../../../src/modules/returns/dto/approve-return.dto';
import { dto } from '../dto';
import { SettingsService } from '../../../src/modules/settings/settings.service';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { MANAGER_PIN, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

/**
 * D101 (3.9) — the rate a line was charged at, frozen at sale time.
 *
 * ## The property this spec exists to defend
 *
 * **3.9 changes no money.** It records a number alongside arithmetic that is
 * otherwise untouched, so a sale completed after it must produce byte-identical
 * `subtotal`, `taxAmount` and `total` to one completed before.
 *
 * That is asserted here permanently rather than checked once, because HARDWARE
 * tenants go through this exact path and other developers work against it in
 * parallel. A regression in these figures is money, not cosmetics.
 *
 * RESTAURANT tenants cannot be affected at all: `billing.service` records that
 * "a restaurant Sale carries no SaleItem rows -- closeSession writes only
 * totals", and the restaurant never calls `SalesService.complete`. The column is
 * structurally unreachable for them, which is a stronger guarantee than any
 * default value.
 */
let prisma: PrismaClient;
let testModule: TestingModule;
let sales: SalesService;
let returns: ReturnsService;
let products: ProductsService;
let settings: SettingsService;
let tenant: SeededTenant;
let owner: AuthenticatedUser;

/** Fixture Product A is 1000.00 — every expected figure below derives from it. */
const UNIT_PRICE = 1000;

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
      ReturnsModule,
      ProductsModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();
  sales = testModule.get(SalesService);
  returns = testModule.get(ReturnsService);
  products = testModule.get(ProductsService);
  settings = testModule.get(SettingsService);
});

afterAll(async () => {
  /*
   * Leave NO global state behind.
   *
   * This is the only spec in the suite that configures a non-zero tax rate, and
   * `beforeEach` above fixes the leak WITHIN this file. It does not fix the leak
   * ACROSS files: the last test leaves its rate in `TenantSettings`, keyed by
   * the deterministic fixture id `tile-tenant`, and every later suite that seeds
   * a tile shop reuses that exact id.
   *
   * `SettingsService.onModuleInit` hydrates its cache from the database at boot,
   * and a suite boots its app BEFORE its first `resetDatabase`. So a later suite
   * would start holding this file's 18% for a tenant it is about to recreate at
   * 0% — and `catalog-adoption`'s "42 — sale inventory adoption is unchanged"
   * pays exactly 2,000 for two 1,000 products, with no headroom for 360 of tax.
   * It fails as a credit sale needing a customer, nowhere near the real cause.
   *
   * Truncating here is stronger than resetting the rate to 0: it removes the row
   * rather than trusting a later reader to interpret it. The leak also survives
   * the jest PROCESS — a leftover row poisons the next run — which is why this
   * belongs in `afterAll` and not only in `beforeEach`.
   */
  await resetDatabase(prisma);
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tenant = await seedTileShopWithQuickBooks(prisma);
  owner = { id: tenant.ownerId, tenantId: tenant.tenantId, role: 'OWNER', activeBranchId: null };
  // `SettingsService` caches per tenant in memory, and `resetDatabase` does not
  // clear that cache -- so a rate set by one test leaks into the next, where a
  // payment sized for 0% no longer covers the total and the sale is refused as
  // credit. Every test starts from an explicit, known rate.
  await setTaxRate(0);
});

async function setTaxRate(percent: number) {
  await settings.updateSettings(tenant.tenantId, { taxRatePercent: percent });
}

function sell(quantity = 1, amount = UNIT_PRICE) {
  return sales.complete(tenant.tenantId, owner, {
    branchId: tenant.branchId,
    registerId: tenant.registerId,
    items: [{ productId: tenant.productAId, quantity }],
    payments: [{ method: 'CASH', amount }],
  });
}

async function lineOf(saleId: string) {
  return prisma.saleItem.findFirstOrThrow({ where: { saleId } });
}

describe('3.9 changes no money — the permanent regression guard', () => {
  it('an untaxed sale produces exactly the figures it produced before', async () => {
    // Pinned absolutely, not relatively: a relative assertion would still pass
    // if both sides drifted together.
    const sale = await sell(2, 2000);

    expect(Number(sale.subtotal)).toBe(2000);
    expect(Number(sale.taxAmount)).toBe(0);
    expect(Number(sale.total)).toBe(2000);
  });

  it('a taxed sale produces exactly the figures it produced before', async () => {
    await setTaxRate(18);

    const sale = await sell(2, 2360);

    // 2000 + 18% = 2360. The order-level arithmetic is untouched by 3.9.
    expect(Number(sale.subtotal)).toBe(2000);
    expect(Number(sale.taxAmount)).toBe(360);
    expect(Number(sale.total)).toBe(2360);
  });

  it('SaleItem.taxAmount is still 0 — per-line COMPUTATION is parked with grocery', async () => {
    await setTaxRate(18);

    const sale = await sell(1, 1180);

    // The snapshot records the RATE. Splitting the order-level tax across lines
    // is a different change, deferred with the per-category work (D101).
    expect(Number((await lineOf(sale.id)).taxAmount)).toBe(0);
  });

  it('an exempt product now REDUCES the tax — 3.10 made the flag bite', async () => {
    // This assertion is INVERTED from what 3.9 shipped, deliberately.
    //
    // 3.9 recorded `taxable` and changed no money, so an exempt line snapshotted
    // 0.00 while the order-level tax still charged on it. A return refunding
    // from that snapshot would have paid back Rs 0 on a line the customer paid
    // Rs 180 of tax for. The old expectation described a state that was
    // internally inconsistent; 3.10 is what removed it.
    await setTaxRate(18);
    await prisma.product.update({ where: { id: tenant.productAId }, data: { taxable: false } });

    const sale = await sell(1, 1000);

    expect(Number(sale.taxAmount)).toBe(0);
    // Untaxed, not unsold: the goods are still on the bill at full price.
    expect(Number(sale.subtotal)).toBe(1000);
    expect(Number(sale.total)).toBe(1000);
  });
});

describe('3.10 — Product.taxable narrows the taxable base', () => {
  it('taxes only the taxable line in a mixed basket', async () => {
    // The case the whole of Phase 3 exists for: a zero-rated staple beside a
    // standard-rated item. B is exempt, A is not.
    await setTaxRate(18);
    await prisma.product.update({ where: { id: tenant.productBId }, data: { taxable: false } });

    const sale = await sales.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      registerId: tenant.registerId,
      items: [
        { productId: tenant.productAId, quantity: 1 },
        { productId: tenant.productBId, quantity: 1 },
      ],
      payments: [{ method: 'CASH', amount: 1430.5 }],
    });

    // Fixture A is 1000.00 and B is 250.50. A is taxed at 18% -> 180.00; B is
    // exempt -> 0. Subtotal is the full 1250.50: exempt is untaxed, not unsold.
    expect(Number(sale.subtotal)).toBe(1250.5);
    expect(Number(sale.taxAmount)).toBe(180);
    expect(Number(sale.total)).toBe(1430.5);

    // And each line records what it was actually charged at. Keyed by PRODUCT
    // rather than by row order: ordering by price put the cheaper exempt line
    // first, and an assertion that depends on which fixture happens to cost more
    // is a test that breaks when somebody edits a price.
    const lines = await prisma.saleItem.findMany({ where: { saleId: sale.id } });
    const rateOf = (productId: string) =>
      Number(lines.find((l) => l.productId === productId)!.taxRatePercent);

    expect(rateOf(tenant.productAId)).toBe(18);
    expect(rateOf(tenant.productBId)).toBe(0);
  });

  it('an all-exempt basket is taxed nothing, never a credit', async () => {
    // Rounding is the only way `exemptNet` could exceed the base, but a negative
    // base would produce NEGATIVE tax — money moving the wrong way.
    await setTaxRate(18);
    await prisma.product.update({ where: { id: tenant.productAId }, data: { taxable: false } });

    const sale = await sell(3, 3000);

    expect(Number(sale.taxAmount)).toBe(0);
    expect(Number(sale.taxAmount)).not.toBeLessThan(0);
  });

  it('removes the exempt line share of the ORDER discount from the base too', async () => {
    // Otherwise the exempt goods would shrink the base twice: once as their own
    // net, once again through a discount share that was never theirs. The
    // formula matches the one `returns.calc` uses to allocate that discount, so
    // sale and refund agree by construction.
    await setTaxRate(10);
    await prisma.product.update({ where: { id: tenant.productBId }, data: { taxable: false } });

    const sale = await sales.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      registerId: tenant.registerId,
      items: [
        { productId: tenant.productAId, quantity: 1 },
        { productId: tenant.productBId, quantity: 1 },
      ],
      orderDiscountType: 'PERCENTAGE',
      orderDiscountValue: 10,
      payments: [{ method: 'CASH', amount: 1215.45 }],
    });

    // Subtotal 1250.50, 10% order discount = 125.05. A's proportional share is
    // 125.05 x 1000/1250.50 = 100.00, so A's taxable net is 900.00 -> 10% = 90.
    // B's 25.05 share leaves the base WITH B, rather than shrinking A's tax
    // twice.
    expect(Number(sale.subtotal)).toBe(1250.5);
    expect(Number(sale.orderDiscountAmount)).toBe(125.05);
    expect(Number(sale.taxAmount)).toBe(90);
    expect(Number(sale.total)).toBe(1215.45);
  });

  it('a fully taxable basket is byte-identical to before 3.10', async () => {
    // The regression guard for hardware. `exemptNet` is 0 for every existing
    // product, so the expression must reduce to exactly what it was.
    await setTaxRate(18);

    const sale = await sales.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      registerId: tenant.registerId,
      items: [
        { productId: tenant.productAId, quantity: 2 },
        { productId: tenant.productBId, quantity: 1 },
      ],
      payments: [{ method: 'CASH', amount: 2655.59 }],
    });

    // 2 x 1000 + 250.50 = 2250.50, +18% = 405.09.
    expect(Number(sale.subtotal)).toBe(2250.5);
    expect(Number(sale.taxAmount)).toBe(405.09);
    expect(Number(sale.total)).toBe(2655.59);
  });
});

describe('the snapshot records what was charged', () => {
  it('a taxable product records the tenant rate', async () => {
    await setTaxRate(18);

    const line = await lineOf((await sell(1, 1180)).id);

    expect(Number(line.taxRatePercent)).toBe(18);
  });

  it('an exempt product records 0.00, not null', async () => {
    await setTaxRate(18);
    await prisma.product.update({ where: { id: tenant.productAId }, data: { taxable: false } });

    const line = await lineOf((await sell(1, 1180)).id);

    expect(line.taxRatePercent).not.toBeNull();
    expect(Number(line.taxRatePercent)).toBe(0);
  });

  it('a tenant configured at 0% also records 0.00 — the same value, correctly', async () => {
    // Both an exempt product and a zero-rated tenant charged nothing, and the
    // column records WHAT WAS CHARGED. `Product.taxable` still distinguishes the
    // two by joining, so nothing is lost.
    const line = await lineOf((await sell(1, UNIT_PRICE)).id);

    expect(Number(line.taxRatePercent)).toBe(0);
  });

  it('NEVER writes null on a new line — the invariant 3.10 depends on', async () => {
    // Null means "written before 3.8". It is the signal the returns fallback
    // uses to tell a historical line from a current one, so a new sale must not
    // be able to produce one. `ComputedLine.taxRatePercent` is required for this
    // reason; this proves the requirement survives to the row.
    for (const rate of [0, 18, 7.5]) {
      await setTaxRate(rate);
      const line = await lineOf((await sell(1, UNIT_PRICE * (1 + rate / 100))).id);

      expect(line.taxRatePercent).not.toBeNull();
    }
  });

  it('freezes the rate — changing it afterwards does not rewrite the sale', async () => {
    await setTaxRate(18);
    const sale = await sell(1, 1180);

    await setTaxRate(25);

    // D44's rule applied to tax: a rate change must not alter a past receipt,
    // and 3.10 will refund from this number rather than today's configuration.
    expect(Number((await lineOf(sale.id)).taxRatePercent)).toBe(18);
    expect(Number((await prisma.sale.findFirstOrThrow({ where: { id: sale.id } })).taxAmount)).toBe(
      180,
    );
  });

  it('records a fractional rate without rounding it away', async () => {
    // DECIMAL(5,2). A rate like 7.5% must survive as 7.50, not 8 or 7.
    await setTaxRate(7.5);

    const line = await lineOf((await sell(1, 1075)).id);

    expect(Number(line.taxRatePercent)).toBe(7.5);
  });
});

describe('restaurant tenants are structurally unaffected', () => {
  it('a restaurant Sale has no SaleItem rows to carry a rate', async () => {
    // Not "safe because taxable defaults true" -- safe because the column cannot
    // be reached. `closeSession` writes totals only; the lines live on the
    // session's orders (billing.service, D51). Asserted from the retail side so
    // the guarantee is pinned without editing restaurant code.
    const restaurantSale = await prisma.sale.create({
      data: {
        tenantId: tenant.tenantId,
        branchId: tenant.branchId,
        saleNumber: 'S-RESTAURANT-SHAPE',
        status: 'COMPLETED',
        cashierId: tenant.ownerId,
        subtotal: 2000,
        totalDiscount: 0,
        orderDiscountAmount: 0,
        taxAmount: 360,
        total: 2360,
        paidAmount: 2360,
        balanceAmount: 0,
        paymentStatus: 'PAID',
      },
    });

    expect(await prisma.saleItem.count({ where: { saleId: restaurantSale.id } })).toBe(0);
    // POSITIVE CONTROL: a retail sale in the same tenant DOES write lines, so
    // the assertion above cannot pass by SaleItem being broken everywhere.
    const retailSale = await sell(1, UNIT_PRICE);
    expect(await prisma.saleItem.count({ where: { saleId: retailSale.id } })).toBe(1);
  });
});

/**
 * D101 (3.11) — a refund allocates the tax the sale actually recorded.
 */
async function refund(
  saleId: string,
  items: { saleItemId: string; qty: number }[],
  refundTotal?: number,
) {
  // A full-sale return needs a manager (returns.service, `isFullReturn`). That
  // is a real rule, obeyed here rather than bypassed, so these tests walk the
  // same path a clerk does. `refundTotal` is supplied only when approval is
  // needed, because the token is bound to the amount.
  let approvalToken: string | undefined;
  if (refundTotal !== undefined) {
    const approval = await returns.approve(
      tenant.tenantId,
      dto(ApproveReturnDto, { managerPin: MANAGER_PIN, originalSaleId: saleId, refundTotal }),
    );
    if (!approval.approved || !approval.approvalToken) {
      throw new Error(`Fixture approval refused: ${approval.reason ?? 'unknown'}`);
    }
    approvalToken = approval.approvalToken;
  }

  return returns.complete(
    tenant.tenantId,
    owner,
    dto(CreateReturnDto, {
      originalSaleId: saleId,
      refundMethod: 'CASH',
      ...(approvalToken ? { approvalToken } : {}),
      items: items.map((i) => ({
        saleItemId: i.saleItemId,
        returnQuantity: i.qty,
        returnReason: 'CHANGED_MIND',
        itemCondition: 'GOOD',
        stockDisposition: 'RETURN_TO_STOCK',
      })),
    }),
    null,
  );
}

describe('3.11 — returns refund the tax the line actually paid', () => {
  it('a mixed basket refunds the taxable line in full and the exempt line nothing', async () => {
    // The end-to-end shape of the whole phase. Before 3.11 the taxable line
    // refunded 143.94 (180 x 1000/1250.50) and the exempt line refunded 36.06 —
    // the shop keeping tax it charged, and paying back tax it never did.
    await setTaxRate(18);
    await prisma.product.update({ where: { id: tenant.productBId }, data: { taxable: false } });

    const sale = await sales.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      registerId: tenant.registerId,
      items: [
        { productId: tenant.productAId, quantity: 1 },
        { productId: tenant.productBId, quantity: 1 },
      ],
      payments: [{ method: 'CASH', amount: 1430.5 }],
    });
    expect(Number(sale.taxAmount)).toBe(180);

    const lines = await prisma.saleItem.findMany({ where: { saleId: sale.id } });
    const lineFor = (productId: string) => lines.find((l) => l.productId === productId)!;

    const taxableReturn = await refund(
      sale.id,
      [{ saleItemId: lineFor(tenant.productAId).id, qty: 1 }],
      1180,
    );
    expect(Number(taxableReturn.taxAdjustment)).toBe(180);

    const exemptReturn = await refund(
      sale.id,
      [{ saleItemId: lineFor(tenant.productBId).id, qty: 1 }],
      250.5,
    );
    expect(Number(exemptReturn.taxAdjustment)).toBe(0);

    // And together they reconcile to what the sale charged.
    expect(
      Number(taxableReturn.taxAdjustment) + Number(exemptReturn.taxAdjustment),
    ).toBe(Number(sale.taxAmount));
  });

  it('split returns reconcile across separate transactions', async () => {
    // Two returns, days apart in practice. Neither is "full", so neither could
    // know to absorb a remainder — allocation makes the question moot.
    await setTaxRate(18);

    const sale = await sell(4, 4720);
    expect(Number(sale.taxAmount)).toBe(720);

    const line = await lineOf(sale.id);
    const first = await refund(sale.id, [{ saleItemId: line.id, qty: 1 }], 1180);
    const second = await refund(sale.id, [{ saleItemId: line.id, qty: 3 }], 3540);

    expect(Number(first.taxAdjustment)).toBe(180);
    expect(Number(second.taxAdjustment)).toBe(540);
    expect(Number(first.taxAdjustment) + Number(second.taxAdjustment)).toBe(720);
  });

  it('stores the reversed rate on the return line', async () => {
    await setTaxRate(18);
    const sale = await sell(1, 1180);
    const line = await lineOf(sale.id);

    const ret = await refund(sale.id, [{ saleItemId: line.id, qty: 1 }], 1180);
    const returnLine = await prisma.returnItem.findFirstOrThrow({ where: { returnId: ret.id } });

    expect(Number(returnLine.taxRatePercent)).toBe(18);
  });

  it('a rate change between sale and return does not alter the refund', async () => {
    await setTaxRate(18);
    const sale = await sell(1, 1180);
    const line = await lineOf(sale.id);

    await setTaxRate(25);

    const ret = await refund(sale.id, [{ saleItemId: line.id, qty: 1 }], 1180);

    // Allocated from the sale's RECORDED tax and the frozen rate, so today's
    // configuration is irrelevant.
    expect(Number(ret.taxAdjustment)).toBe(180);
    expect(Number((await prisma.returnItem.findFirstOrThrow({ where: { returnId: ret.id } })).taxRatePercent)).toBe(18);
  });

  it('a PRE-3.8 sale falls back to proportional refunding, unchanged', async () => {
    // The guarantee that protects live data. The rate columns are nulled to
    // reproduce a sale written before 3.8 existed; the refund must be what that
    // sale would always have received.
    await setTaxRate(18);
    const sale = await sell(4, 4720);
    const line = await lineOf(sale.id);

    await prisma.saleItem.updateMany({
      where: { saleId: sale.id },
      data: { taxRatePercent: null },
    });

    const ret = await refund(sale.id, [{ saleItemId: line.id, qty: 2 }]);

    // 720 x (2000/4000) — the proportional formula, untouched.
    expect(Number(ret.taxAdjustment)).toBe(360);
    // And the return records that no rate was known, rather than inventing one.
    expect(
      (await prisma.returnItem.findFirstOrThrow({ where: { returnId: ret.id } })).taxRatePercent,
    ).toBeNull();
  });
});

/**
 * D101 (3.13) — the API accepts `taxable`, and absent means taxable.
 *
 * This is the step that makes everything 3.8–3.12 built REACHABLE: until now
 * the flag could only be set by writing the column directly.
 */
describe('3.13 — the API layer defaults to taxable', () => {
  const newProduct = (over: Record<string, unknown> = {}) =>
    products.create(
      tenant.tenantId,
      dto(CreateProductDto, { name: 'Wizard Product', type: 'Inventory', unitPrice: 500, ...over }),
    );

  it('creates a TAXABLE product when the field is omitted', async () => {
    // THE zero-breakage guarantee. Any client that predates this field -- an
    // integration, an older build, an import script -- must not silently
    // zero-rate what it creates.
    const created = await newProduct();

    expect((await prisma.product.findFirstOrThrow({ where: { id: created.id } })).taxable).toBe(
      true,
    );
  });

  it('honours an explicit false', async () => {
    const created = await newProduct({ taxable: false });

    expect((await prisma.product.findFirstOrThrow({ where: { id: created.id } })).taxable).toBe(
      false,
    );
  });

  it('an update that omits the field leaves the stored value alone', async () => {
    // A partial update must not make a product exempt by omission -- the reason
    // the service passes `dto.taxable` through rather than defaulting it again.
    const created = await newProduct({ taxable: false });

    await products.update(tenant.tenantId, created.id, dto(UpdateProductDto, { name: 'Renamed' }), 'OWNER');

    const row = await prisma.product.findFirstOrThrow({ where: { id: created.id } });
    expect(row.name).toBe('Renamed');
    expect(row.taxable).toBe(false);
  });

  it('an update can flip it back', async () => {
    const created = await newProduct({ taxable: false });

    await products.update(tenant.tenantId, created.id, dto(UpdateProductDto, { taxable: true }), 'OWNER');

    expect((await prisma.product.findFirstOrThrow({ where: { id: created.id } })).taxable).toBe(
      true,
    );
  });

  it('a product marked exempt through the API is untaxed on a real sale', async () => {
    // The end-to-end proof that the toggle reaches the money: 3.13 -> 3.10.
    // Everything between them is inert without this.
    await setTaxRate(18);
    const exempt = await newProduct({ taxable: false, unitPrice: 500, quantityOnHand: 10 });

    const sale = await sales.complete(tenant.tenantId, owner, {
      branchId: tenant.branchId,
      registerId: tenant.registerId,
      items: [{ productId: exempt.id, quantity: 2 }],
      payments: [{ method: 'CASH', amount: 1000 }],
    });

    expect(Number(sale.subtotal)).toBe(1000);
    expect(Number(sale.taxAmount)).toBe(0);
    expect(Number(sale.total)).toBe(1000);

    // And the line records the rate it was actually charged at.
    const line = await lineOf(sale.id);
    expect(Number(line.taxRatePercent)).toBe(0);
  });
});
