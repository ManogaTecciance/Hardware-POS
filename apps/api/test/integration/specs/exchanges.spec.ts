/**
 * D107 / D107a — an exchange is a return followed by a sale, settled GROSS
 * (Phase 7, `7.1b` and `7.2`).
 *
 * D107 first netted the two legs through `STORE_CREDIT`. `ReturnsService`
 * refuses a store-credit refund unless the sale has a saved, non-walk-in
 * customer — correctly, since store credit is a liability held against an
 * account — and a shop swapping a size is almost always a walk-in. So the
 * money moves twice and nets at the drawer, which needs no change to any
 * existing money path.
 *
 * ## What can only be proven here
 *
 *  • That composing two services that each own their `$transaction` produces the
 *    right money and the right stock. A mocked return or sale would prove only
 *    that this file's arithmetic matches itself.
 *  • The **recoverable state**: that a failed replacement leaves the exchange
 *    row with a null `replacementSaleId` AND the customer already refunded.
 *    D107 asserts this is safe; a test has to show it, not repeat it.
 *  • Idempotency across two money movements — the case where a duplicate would
 *    refund a customer for goods they kept.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * Every money figure is asserted as an exact amount, not a direction: an
 * implementation that refunded everything and charged nothing would satisfy
 * "the customer owes less" but fails `netDifference` equality. The three
 * price relationships — replacement dearer, cheaper, and identical — are
 * asserted together, and each checks BOTH legs: the refund the customer
 * received and the tender they paid. An implementation that refunded nothing
 * would still satisfy a one-sided "the sale was paid" assertion. Stock is
 * asserted on BOTH variants and before/after, so a change that moved one and
 * forgot the other cannot pass.
 */

import type { PrismaClient } from '@hardware-pos/database';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { dto } from '../dto';
import { MANAGER_PIN, seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';
import { createIntegrationApp, type IntegrationApp } from '../test-app';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';
import { ApproveReturnDto } from '../../../src/modules/returns/dto/approve-return.dto';
import type { SaleWithRelations } from '../../../src/modules/sales/sales.repository';

let prisma: PrismaClient;
let app: IntegrationApp;
let tenant: SeededTenant;
let owner: AuthenticatedUser;

/** Two variants of Product A: the Medium sold, the Large swapped to. */
let mediumId: string;
let largeId: string;

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
  // LOCAL inventory, explicitly. Without a profile the provider factory does not
  // resolve to the local path and stock never moves — which would make every
  // stock assertion below vacuously true.
  await prisma.tenantBusinessProfile.create({
    data: {
      tenantId: tenant.tenantId,
      businessType: 'RETAIL',
      inventoryMode: 'LOCAL',
      accountingProvider: 'NONE',
    },
  });
  owner = { id: tenant.ownerId, tenantId: tenant.tenantId, role: 'OWNER', activeBranchId: null };
});

/**
 * Give Product A two variants and stock them.
 *
 * `largePrice` defaults to the Medium's price — the same-price size swap that is
 * the common case — and is overridden to prove the dearer and cheaper paths.
 */
async function seedVariants(mediumPrice = 1000, largePrice = 1000): Promise<void> {
  await prisma.product.update({
    where: { id: tenant.productAId },
    data: { hasVariants: true },
  });
  const medium = await prisma.productVariant.create({
    data: {
      tenantId: tenant.tenantId,
      productId: tenant.productAId,
      sku: 'A-M',
      unitPrice: mediumPrice,
      isDefault: true,
    },
  });
  const large = await prisma.productVariant.create({
    data: {
      tenantId: tenant.tenantId,
      productId: tenant.productAId,
      sku: 'A-L',
      unitPrice: largePrice,
    },
  });
  mediumId = medium.id;
  largeId = large.id;

  for (const variantId of [mediumId, largeId]) {
    await prisma.branchInventory.create({
      data: {
        tenantId: tenant.tenantId,
        branchId: tenant.branchId,
        productId: tenant.productAId,
        productVariantId: variantId,
        quantityOnHand: 10,
      },
    });
  }
}

/** A completed, fully-paid sale of one Medium. */
async function soldOneMedium(price = 1000): Promise<SaleWithRelations> {
  return app.salesService.complete(tenant.tenantId, owner, {
    branchId: tenant.branchId,
    registerId: tenant.registerId,
    items: [{ productId: tenant.productAId, productVariantId: mediumId, quantity: 1 }],
    payments: [{ method: 'CASH' as const, amount: price }],
  });
}

function returnLine(sale: SaleWithRelations) {
  return {
    saleItemId: sale.items[0]!.id,
    returnQuantity: 1,
    // A size swap is 'not suitable', not a wrong product: the shop sent what
    // was ordered and it did not fit.
    returnReason: 'NOT_SUITABLE' as const,
    itemCondition: 'GOOD' as const,
    stockDisposition: 'RETURN_TO_STOCK' as const,
  };
}

async function onHand(variantId: string): Promise<number> {
  const row = await prisma.branchInventory.findFirstOrThrow({
    where: { productVariantId: variantId, branchId: tenant.branchId },
  });
  return Number(row.quantityOnHand);
}

/**
 * A manager PIN, because the returning leg needs one.
 *
 * D107: existing return-approval rules apply unchanged, and `Full-sale
 * return` is one of the triggers. A customer who bought one shirt and swaps
 * the size is returning the whole sale, so **every single-line exchange
 * needs an approval** — a real consequence of the approved decision, not an
 * artefact of this fixture. Recorded as a Phase 7 limitation.
 */
async function managerApproval(saleId: string, refundTotal: number): Promise<string> {
  const result = await app.returnsService.approve(
    tenant.tenantId,
    dto(ApproveReturnDto, { managerPin: MANAGER_PIN, originalSaleId: saleId, refundTotal }),
  );
  if (!result.approved || !result.approvalToken) {
    throw new Error(`Manager approval was refused: ${result.reason ?? 'unknown'}`);
  }
  return result.approvalToken;
}

// ── The money ────────────────────────────────────────────────────────────────

describe('an even swap — the common case', () => {
  it('refunds what came back and charges for what goes out, netting zero', async () => {
    await seedVariants();
    const sale = await soldOneMedium();

    const exchange = await app.exchangesService.complete(
      tenant.tenantId,
      owner,
      {
        originalSaleId: sale.id,
        branchId: tenant.branchId,
        registerId: tenant.registerId,
        returnItems: [returnLine(sale)],
        approvalToken: await managerApproval(sale.id, Number(sale.total)),
        replacementItems: [
          { productId: tenant.productAId, productVariantId: largeId, quantity: 1 },
        ],
        // The replacement is paid for in full, like any other sale. The
        // customer is handed 1000 back on the returning leg, so the drawer
        // nets to zero — which is what an even swap looks like at a counter.
        payments: [{ method: 'CASH' as const, amount: 1000 }],
      },
      null,
    );

    expect(exchange.exchangeNumber).toMatch(/^X-\d{6}$/);
    expect(exchange.returnedValue).toBe(1000);
    expect(exchange.replacementValue).toBe(1000);
    expect(exchange.netDifference).toBe(0);
    expect(exchange.complete).toBe(true);
    expect(exchange.replacementSaleId).not.toBeNull();

    // Both legs really moved: the refund out, the tender in.
    const refund = await prisma.return.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    });
    expect(refund.refundMethod).toBe('CASH');
    expect(Number(refund.refundTotal)).toBe(1000);

    const payments = await prisma.payment.findMany({
      where: { saleId: exchange.replacementSaleId! },
    });
    expect(payments).toHaveLength(1);
    expect(Number(payments[0]!.amount)).toBe(1000);
  });
});

describe('an upgrade — the replacement costs more', () => {
  it('refunds 1000 and charges 1500, so 500 leaves the customer pocket', async () => {
    await seedVariants(1000, 1500);
    const sale = await soldOneMedium();

    const exchange = await app.exchangesService.complete(
      tenant.tenantId,
      owner,
      {
        originalSaleId: sale.id,
        branchId: tenant.branchId,
        registerId: tenant.registerId,
        returnItems: [returnLine(sale)],
        approvalToken: await managerApproval(sale.id, Number(sale.total)),
        replacementItems: [
          { productId: tenant.productAId, productVariantId: largeId, quantity: 1 },
        ],
        // Full price for the replacement. The customer is handed 1000 back,
        // so 500 is what actually leaves their pocket.
        payments: [{ method: 'CASH' as const, amount: 1500 }],
      },
      null,
    );

    expect(exchange.returnedValue).toBe(1000);
    expect(exchange.replacementValue).toBe(1500);
    expect(exchange.netDifference).toBe(500);

    const refund = await prisma.return.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    });
    const payments = await prisma.payment.findMany({
      where: { saleId: exchange.replacementSaleId! },
    });
    // Both sides asserted: 1000 out, 1500 in, netting 500. Asserting only
    // the tender would pass for an implementation that never refunded.
    expect(Number(refund.refundTotal)).toBe(1000);
    expect(payments.map((p) => Number(p.amount))).toEqual([1500]);
  });
});

describe('a downgrade — the replacement costs less', () => {
  it('refunds 1500 and charges 1000, so the customer leaves 500 better off', async () => {
    await seedVariants(1500, 1000);
    const sale = await soldOneMedium(1500);

    const exchange = await app.exchangesService.complete(
      tenant.tenantId,
      owner,
      {
        originalSaleId: sale.id,
        branchId: tenant.branchId,
        registerId: tenant.registerId,
        returnItems: [returnLine(sale)],
        approvalToken: await managerApproval(sale.id, Number(sale.total)),
        replacementItems: [
          { productId: tenant.productAId, productVariantId: largeId, quantity: 1 },
        ],
        payments: [{ method: 'CASH' as const, amount: 1000 }],
      },
      null,
    );

    expect(exchange.returnedValue).toBe(1500);
    expect(exchange.replacementValue).toBe(1000);
    expect(exchange.netDifference).toBe(-500);

    // 1500 out, 1000 in: the customer leaves 500 better off, which is the
    // whole point of a downgrade and is what nets at the drawer.
    const refund = await prisma.return.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
    });
    expect(Number(refund.refundTotal)).toBe(1500);
    const payments = await prisma.payment.findMany({
      where: { saleId: exchange.replacementSaleId! },
    });
    expect(payments.map((p) => Number(p.amount))).toEqual([1000]);
  });
});

// ── 7.2 — the stock ─────────────────────────────────────────────────────────

describe('stock moves on both variants, once', () => {
  it('restocks the returned variant and decrements the replacement', async () => {
    await seedVariants();
    const sale = await soldOneMedium();

    // After the sale: the Medium is down one, the Large untouched.
    expect(await onHand(mediumId)).toBe(9);
    expect(await onHand(largeId)).toBe(10);

    await app.exchangesService.complete(
      tenant.tenantId,
      owner,
      {
        originalSaleId: sale.id,
        branchId: tenant.branchId,
        registerId: tenant.registerId,
        returnItems: [returnLine(sale)],
        approvalToken: await managerApproval(sale.id, Number(sale.total)),
        replacementItems: [
          { productId: tenant.productAId, productVariantId: largeId, quantity: 1 },
        ],
        payments: [{ method: 'CASH' as const, amount: 1000 }],
      },
      null,
    );

    // Both moved, each by exactly one. Asserted on BOTH variants: an
    // implementation that restocked and forgot to decrement passes half of this.
    expect(await onHand(mediumId)).toBe(10);
    expect(await onHand(largeId)).toBe(9);
  });

  it('a replayed exchange moves no stock a second time', async () => {
    await seedVariants();
    const sale = await soldOneMedium();
    const request = {
      originalSaleId: sale.id,
      branchId: tenant.branchId,
      registerId: tenant.registerId,
      returnItems: [returnLine(sale)],
        approvalToken: await managerApproval(sale.id, Number(sale.total)),
      replacementItems: [{ productId: tenant.productAId, productVariantId: largeId, quantity: 1 }],
      payments: [{ method: 'CASH' as const, amount: 1000 }],
      idempotencyKey: 'exch-key-1',
    };

    await app.exchangesService.complete(tenant.tenantId, owner, request, null);
    expect(await onHand(mediumId)).toBe(10);
    expect(await onHand(largeId)).toBe(9);

    await app.exchangesService.complete(tenant.tenantId, owner, request, null);

    // Unchanged. A replay that re-ran either leg would show 11 and 8.
    expect(await onHand(mediumId)).toBe(10);
    expect(await onHand(largeId)).toBe(9);
  });
});

// ── Idempotency ─────────────────────────────────────────────────────────────

describe('a replayed exchange', () => {
  it('returns the SAME exchange and does not refund twice', async () => {
    await seedVariants();
    const sale = await soldOneMedium();
    const request = {
      originalSaleId: sale.id,
      branchId: tenant.branchId,
      registerId: tenant.registerId,
      returnItems: [returnLine(sale)],
        approvalToken: await managerApproval(sale.id, Number(sale.total)),
      replacementItems: [{ productId: tenant.productAId, productVariantId: largeId, quantity: 1 }],
      payments: [{ method: 'CASH' as const, amount: 1000 }],
      idempotencyKey: 'exch-key-2',
    };

    const first = await app.exchangesService.complete(tenant.tenantId, owner, request, null);
    const second = await app.exchangesService.complete(tenant.tenantId, owner, request, null);

    expect(second.id).toBe(first.id);
    expect(second.exchangeNumber).toBe(first.exchangeNumber);
    expect(second.returnId).toBe(first.returnId);
    expect(second.replacementSaleId).toBe(first.replacementSaleId);

    // One of each, in the database. This is the assertion that matters: a
    // duplicate would have refunded a customer for goods they kept.
    expect(await prisma.exchange.count({ where: { tenantId: tenant.tenantId } })).toBe(1);
    expect(await prisma.return.count({ where: { tenantId: tenant.tenantId } })).toBe(1);
  });

  it('honours the Idempotency-Key header as well as the body field', async () => {
    await seedVariants();
    const sale = await soldOneMedium();
    const request = {
      originalSaleId: sale.id,
      branchId: tenant.branchId,
      registerId: tenant.registerId,
      returnItems: [returnLine(sale)],
        approvalToken: await managerApproval(sale.id, Number(sale.total)),
      replacementItems: [{ productId: tenant.productAId, productVariantId: largeId, quantity: 1 }],
      payments: [{ method: 'CASH' as const, amount: 1000 }],
    };

    const first = await app.exchangesService.complete(tenant.tenantId, owner, request, 'hdr-key');
    const second = await app.exchangesService.complete(tenant.tenantId, owner, request, 'hdr-key');
    expect(second.id).toBe(first.id);
    expect(await prisma.exchange.count({ where: { tenantId: tenant.tenantId } })).toBe(1);
  });
});

// ── The recoverable state D107 claims ───────────────────────────────────────

describe('when the replacement leg fails', () => {
  it('leaves the exchange open AND the customer already refunded', async () => {
    await seedVariants();
    const sale = await soldOneMedium();

    // A replacement that cannot succeed: a variant id that is not this
    // tenant's. The sale path refuses it, which is the failure being staged.
    await expect(
      app.exchangesService.complete(
        tenant.tenantId,
        owner,
        {
          originalSaleId: sale.id,
          branchId: tenant.branchId,
          registerId: tenant.registerId,
          returnItems: [returnLine(sale)],
        approvalToken: await managerApproval(sale.id, Number(sale.total)),
          replacementItems: [
            { productId: tenant.productAId, productVariantId: 'not-a-real-variant', quantity: 1 },
          ],
          payments: [{ method: 'CASH' as const, amount: 1000 }],
        },
        null,
      ),
    ).rejects.toBeDefined();

    // The exchange row survives, open. `replacementSaleId` being nullable is
    // what makes this expressible at all (D107).
    const exchanges = await prisma.exchange.findMany({ where: { tenantId: tenant.tenantId } });
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.replacementSaleId).toBeNull();

    // And the money is where D107a says it is: the return completed and the
    // customer was refunded exactly what they handed back. Nothing is lost
    // and nothing is double-counted — the operator can ring the replacement
    // up as an ordinary sale.
    const returns = await prisma.return.findMany({ where: { tenantId: tenant.tenantId } });
    expect(returns).toHaveLength(1);
    expect(returns[0]!.refundMethod).toBe('CASH');
    expect(Number(returns[0]!.refundTotal)).toBe(1000);

    // The returned stock is back on the shelf; the replacement never moved.
    expect(await onHand(mediumId)).toBe(10);
    expect(await onHand(largeId)).toBe(10);

    // The read model reports it honestly rather than pretending it finished.
    const view = await app.exchangesService.getById(tenant.tenantId, exchanges[0]!.id);
    expect(view.complete).toBe(false);
    expect(view.replacementValue).toBeNull();
    expect(view.netDifference).toBeNull();
  });
});

// ── Tenant isolation ────────────────────────────────────────────────────────

describe('scoping', () => {
  it('does not return another tenant exchange by id', async () => {
    await seedVariants();
    const sale = await soldOneMedium();
    const exchange = await app.exchangesService.complete(
      tenant.tenantId,
      owner,
      {
        originalSaleId: sale.id,
        branchId: tenant.branchId,
        registerId: tenant.registerId,
        returnItems: [returnLine(sale)],
        approvalToken: await managerApproval(sale.id, Number(sale.total)),
        replacementItems: [
          { productId: tenant.productAId, productVariantId: largeId, quantity: 1 },
        ],
        payments: [{ method: 'CASH' as const, amount: 1000 }],
      },
      null,
    );

    await expect(app.exchangesService.getById('some-other-tenant', exchange.id)).rejects.toThrow(
      /not found/i,
    );
  });
});
