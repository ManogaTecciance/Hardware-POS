/**
 * D102 (4.4) — a promotion reduces what the customer actually pays.
 *
 * ## The figures here are shared with the till
 *
 * `apps/web/src/lib/cart-line-key.test.ts` pins the SAME basket to the SAME
 * numbers — 2,500 subtotal, 500 promotion, 360 tax, 2,360 total. Both sides call
 * `applyPromotions` from `@hardware-pos/shared`, so two specs asserting one set
 * of figures is the till-server agreement in practice. That is the guarantee
 * 3.14 established for tax, extended to promotions, and it matters more here:
 * with tax the customer saw a wrong number after agreeing to buy, whereas a
 * promotion is advertised on a badge BEFORE they commit.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The BOGO case asserts WHICH LINE carries the saving, not merely that the total
 * fell by 500. Spreading it across the basket would produce the same total and
 * still refund 400 on a free item — the defect D102 exists to prevent.
 *
 * The invariant case asserts `discountedSubtotal === Σ lineTotal` against the
 * PERSISTED rows, because that pair is what the order discount and the tax base
 * are both derived from. It is mutation-proven below.
 */
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

let prisma: PrismaClient;
let testModule: TestingModule;
let sales: SalesService;
let returns: ReturnsService;
let settings: SettingsService;
let tenant: SeededTenant;
let owner: AuthenticatedUser;

/** Created per test so the prices are the ones the figures below are built on. */
let shirtId: string;
let tieId: string;

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
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();
  sales = testModule.get(SalesService);
  returns = testModule.get(ReturnsService);
  settings = testModule.get(SettingsService);
});

afterAll(async () => {
  // Leave no global state behind (3.16's lesson): this file writes a tax rate
  // and promotions against the deterministic `tile-tenant` fixture id, and a
  // later suite boots its app before its own reset.
  await resetDatabase(prisma);
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tenant = await seedTileShopWithQuickBooks(prisma);
  owner = { id: tenant.ownerId, tenantId: tenant.tenantId, role: 'OWNER', activeBranchId: null };
  // `SettingsService` caches per tenant and `resetDatabase` does not clear it,
  // so every test states its own rate rather than inheriting one.
  await settings.updateSettings(tenant.tenantId, { taxRatePercent: 18 });

  const shirt = await prisma.product.create({
    data: {
      tenantId: tenant.tenantId,
      name: 'Shirt',
      type: 'Inventory',
      sku: 'PROMO-SHIRT',
      unitPrice: '1000.00',
      costPrice: '600.00',
      quantityOnHand: '100.000',
    },
  });
  const tie = await prisma.product.create({
    data: {
      tenantId: tenant.tenantId,
      name: 'Tie',
      type: 'Inventory',
      sku: 'PROMO-TIE',
      unitPrice: '500.00',
      costPrice: '200.00',
      quantityOnHand: '100.000',
    },
  });
  shirtId = shirt.id;
  tieId = tie.id;
});

/** Buy 2 shirts, get a tie free. */
async function seedBogo() {
  return prisma.promotion.create({
    data: {
      tenantId: tenant.tenantId,
      name: 'Buy 2 shirts, tie free',
      type: 'BUY_X_GET_Y',
      buyQuantity: 2,
      getQuantity: 1,
      stackable: false,
      isActive: true,
      items: {
        create: [
          { productId: shirtId, role: 'BUY', quantity: 1 },
          { productId: tieId, role: 'GET', quantity: 1 },
        ],
      },
    },
  });
}

/** 2 shirts + 1 tie, paid in full. */
const sellBasket = (amount: number) =>
  sales.complete(tenant.tenantId, owner, {
    branchId: tenant.branchId,
    registerId: tenant.registerId,
    items: [
      { productId: shirtId, quantity: 2 },
      { productId: tieId, quantity: 1 },
    ],
    payments: [{ method: 'CASH', amount }],
  });

const linesOf = (saleId: string) =>
  prisma.saleItem.findMany({ where: { saleId }, orderBy: { productName: 'asc' } });

describe('4.4 — a promotion reduces what the customer pays', () => {
  it('charges the promoted total, and taxes only what was owed', async () => {
    await seedBogo();

    const sale = await sellBasket(2360);

    // The same four figures the till's own spec pins.
    expect(Number(sale.subtotal)).toBe(2500);
    expect(Number(sale.totalDiscount)).toBe(500);
    expect(Number(sale.taxAmount)).toBe(360);
    expect(Number(sale.total)).toBe(2360);
  });

  it('puts the whole saving on the FREE line and freezes it there', async () => {
    const promo = await seedBogo();

    const sale = await sellBasket(2360);
    const [shirtLine, tieLine] = await linesOf(sale.id); // 'Shirt' then 'Tie'

    // POSITIVE: the tie carries all 500, nets to zero, and names its offer.
    expect(Number(tieLine!.promotionDiscountAmount)).toBe(500);
    expect(Number(tieLine!.lineTotal)).toBe(0);
    expect(tieLine!.promotionId).toBe(promo.id);
    expect(tieLine!.promotionNameSnapshot).toBe('Buy 2 shirts, tie free');

    // NEGATIVE: the shirts are untouched. Spreading the saving by line value
    // would give the tie 100 and refund 400 on an item paid nothing for.
    expect(Number(shirtLine!.promotionDiscountAmount)).toBe(0);
    expect(Number(shirtLine!.lineTotal)).toBe(2000);
    expect(shirtLine!.promotionId).toBeNull();
  });

  it('INVARIANT — discountedSubtotal equals Σ lineTotal on the persisted sale', async () => {
    await seedBogo();

    const sale = await sellBasket(2360);
    const lines = await linesOf(sale.id);

    const discountedSubtotal = Number(sale.subtotal) - Number(sale.totalDiscount);
    const sumLineTotals = lines.reduce((acc, l) => acc + Number(l.lineTotal), 0);

    /*
     * The pair everything downstream rests on. The order discount is computed
     * on `discountedSubtotal`; `taxableBase` narrows from it; `returns.calc`
     * uses `subtotal − totalDiscount` as its denominator. If a promotion
     * reduced the lines without entering `totalDiscount`, all three drift at
     * once and silently.
     *
     * MUTATION-PROVEN: reverting `totalDiscount` to the pre-4.4 expression —
     * summing only `discountAmount` — fails FOUR of the six cases here: this
     * invariant, the charged total, the free-line case and the exempt case. The
     * two that survive are the ones with no promotion in play, which is the
     * correct blind spot: there is nothing for the mutation to change.
     */
    expect(discountedSubtotal).toBe(sumLineTotals);
    expect(discountedSubtotal).toBe(2000);
  });

  it('an EXEMPT free item is untaxed, and the two rules compose', async () => {
    await prisma.product.update({ where: { id: tieId }, data: { taxable: false } });
    await seedBogo();

    const sale = await sellBasket(2360);

    // 18% of the shirts alone — the same answer whether the tie is exempt or
    // free, which is the point: neither rule needs to know about the other.
    expect(Number(sale.taxAmount)).toBe(360);
    expect(Number(sale.total)).toBe(2360);
  });

  it('an out-of-window promotion changes nothing', async () => {
    await seedBogo();
    await prisma.promotion.updateMany({
      where: { tenantId: tenant.tenantId },
      data: { endsOn: new Date('2020-01-01T00:00:00.000Z') },
    });

    // Full price: 2,500 + 18% = 2,950.
    const sale = await sellBasket(2950);

    expect(Number(sale.totalDiscount)).toBe(0);
    expect(Number(sale.total)).toBe(2950);
    const lines = await linesOf(sale.id);
    for (const l of lines) expect(Number(l.promotionDiscountAmount)).toBe(0);
  });

  it('ZERO-CHANGE — a tenant with no promotions sells exactly as before', async () => {
    const sale = await sellBasket(2950);

    expect(Number(sale.subtotal)).toBe(2500);
    expect(Number(sale.totalDiscount)).toBe(0);
    expect(Number(sale.taxAmount)).toBe(450);
    expect(Number(sale.total)).toBe(2950);

    const lines = await linesOf(sale.id);
    for (const l of lines) {
      expect(Number(l.promotionDiscountAmount)).toBe(0);
      expect(l.promotionId).toBeNull();
      expect(l.promotionNameSnapshot).toBeNull();
    }
  });
});

describe('4.5 — a return reverses the promotion it was given', () => {
  /**
   * A return, with a manager approval token when the refund crosses the value
   * threshold. The threshold is a pre-existing rule and nothing to do with
   * promotions — it simply has to be satisfied to exercise a full basket.
   */
  const returnOf = async (
    saleId: string,
    saleItemId: string,
    qty: number,
    approveFor?: number,
  ) => {
    let approvalToken: string | undefined;
    if (approveFor !== undefined) {
      const approval = await returns.approve(
        tenant.tenantId,
        dto(ApproveReturnDto, {
          managerPin: MANAGER_PIN,
          originalSaleId: saleId,
          refundTotal: approveFor,
        }),
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
        items: [
          {
            saleItemId,
            returnQuantity: qty,
            returnReason: 'CHANGED_MIND',
            itemCondition: 'GOOD',
            stockDisposition: 'RETURN_TO_STOCK',
          },
        ],
      }),
      null,
    );
  };

  it('THE D102 CASE — returning the free tie refunds exactly 0.00', async () => {
    await seedBogo();
    const sale = await sellBasket(2360);
    const [, tieLine] = await linesOf(sale.id); // 'Shirt' then 'Tie'

    const ret = await returnOf(sale.id, tieLine!.id, 1);

    /*
     * End to end, against the database, with real money moved. The customer paid
     * nothing for the tie and gets nothing back.
     *
     * Had the 500 been allocated ORDER-WIDE by line value — weight 500 against
     * the shirts' 2,000 — the tie would have absorbed 100 and this refund would
     * be 400 on a free item. That is what D102 Option A was chosen to prevent,
     * and it is why the breakdown is asserted and not only the total.
     */
    expect(Number(ret.refundTotal)).toBe(0);

    const items = await prisma.returnItem.findMany({ where: { returnId: ret.id } });
    expect(items).toHaveLength(1);
    expect(Number(items[0]!.promotionDiscountAdjustment)).toBe(500);
    expect(Number(items[0]!.originalLineSubtotal)).toBe(500);
    expect(Number(items[0]!.taxAdjustment)).toBe(0);
    expect(Number(items[0]!.refundableAmount)).toBe(0);
  });

  it('the PAID item still refunds everything it paid — the control', async () => {
    await seedBogo();
    const sale = await sellBasket(2360);
    const [shirtLine] = await linesOf(sale.id);

    const ret = await returnOf(sale.id, shirtLine!.id, 1);

    // One of two shirts: 1,000 of goods plus its half of the 360 tax. Proves the
    // zero above is about the promotion, not a calculator refunding nothing.
    expect(Number(ret.refundTotal)).toBe(1180);
    const items = await prisma.returnItem.findMany({ where: { returnId: ret.id } });
    expect(Number(items[0]!.promotionDiscountAdjustment)).toBe(0);
  });

  it('returning EVERYTHING, piece by piece, gives back exactly what was paid', async () => {
    await seedBogo();
    const sale = await sellBasket(2360);
    const [shirtLine, tieLine] = await linesOf(sale.id);

    /*
     * Three separate transactions, deliberately: the free tie, then one shirt,
     * then the other. Allocation makes each share exact on its own, so the parts
     * sum to the whole however the customer splits the return and no line has to
     * absorb a remainder — the reconciliation property 3.11 built and D102
     * inherits by allocating rather than re-evaluating.
     *
     * Each refund stays under the manager-approval threshold, which is a
     * pre-existing value rule and nothing to do with promotions.
     */
    const tie = await returnOf(sale.id, tieLine!.id, 1);
    const firstShirt = await returnOf(sale.id, shirtLine!.id, 1);
    // The third one completes the sale, so it trips the pre-existing
    // "Full-sale return" approval rule — nothing to do with promotions.
    const secondShirt = await returnOf(sale.id, shirtLine!.id, 1, 1180);

    expect(Number(tie.refundTotal)).toBe(0);
    expect(Number(firstShirt.refundTotal)).toBe(1180);
    expect(Number(secondShirt.refundTotal)).toBe(1180);
    expect(
      Number(tie.refundTotal) + Number(firstShirt.refundTotal) + Number(secondShirt.refundTotal),
    ).toBe(2360);
  });

  it('ZERO-CHANGE — an unpromoted sale refunds exactly as it did before', async () => {
    const sale = await sellBasket(2950);
    const [shirtLine] = await linesOf(sale.id);

    const ret = await returnOf(sale.id, shirtLine!.id, 1);

    // 1,000 of goods + 180 tax, and nothing promotional recorded.
    expect(Number(ret.refundTotal)).toBe(1180);
    const items = await prisma.returnItem.findMany({ where: { returnId: ret.id } });
    expect(Number(items[0]!.promotionDiscountAdjustment)).toBe(0);
  });
});
