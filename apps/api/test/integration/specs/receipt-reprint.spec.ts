/**
 * Which sales have a receipt, and what a voided one prints (2026-09-08).
 *
 * ## The rule this replaced
 *
 * `loadCompletedSale` demanded `SaleStatus.COMPLETED`, which put an arbitrary
 * cliff at a full return: refund 99% of a sale and its status stayed
 * `COMPLETED` and the receipt reprinted; refund the last 1% and the status
 * became `REFUNDED` and the receipt was gone. **Every exchange crossed that
 * cliff** — a size swap returns the whole sale by definition (D130) — so after
 * any exchange the original receipt became unreachable.
 *
 * The sale happened and money moved; the receipt is the record of it. A
 * customer or an auditor asking for the receipt of a later-returned sale is
 * ordinary, so `REFUNDED` and `VOIDED` both reprint now.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The permission is asserted from both sides. `DRAFT` is still refused, and
 * that refusal is asserted alongside the allowances — without it, "REFUNDED
 * reprints" would also pass for a service that had stopped checking status at
 * all, which would hand a receipt to a held basket that has taken no money.
 *
 * The VOID stamp is asserted positively AND negatively: present on a voided
 * sale, absent on a live one. A test for the stamp alone would pass for a
 * template that stamped every receipt ever printed.
 */
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '@hardware-pos/database';

import { validateEnv } from '../../../src/config/env.validation';
import { StorageModule } from '../../../src/common/storage/storage.module';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { ReceiptsModule } from '../../../src/modules/receipts/receipts.module';
import { ReceiptsService } from '../../../src/modules/receipts/receipts.service';
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { SalesService } from '../../../src/modules/sales/sales.service';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { seedTileShopWithQuickBooks, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let sales: SalesService;
let receipts: ReceiptsService;
let tenant: SeededTenant;
let owner: AuthenticatedUser;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  testModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      StorageModule,
      PrismaModule,
      SalesModule,
      ReceiptsModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();

  sales = testModule.get(SalesService);
  receipts = testModule.get(ReceiptsService);
});

afterAll(async () => {
  await testModule.close();
  await disconnectTestPrisma();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  tenant = await seedTileShopWithQuickBooks(prisma);
  owner = { id: tenant.ownerId, tenantId: tenant.tenantId, role: 'OWNER', activeBranchId: null };
});

function paidSale() {
  return sales.complete(tenant.tenantId, owner, {
    branchId: tenant.branchId,
    registerId: tenant.registerId,
    items: [{ productId: tenant.productAId, quantity: 1 }],
    payments: [{ method: 'CASH', amount: 1000 }],
  });
}

/** The rendered receipt HTML, which is what the print job carries. */
async function receiptHtml(saleId: string): Promise<string> {
  const result = await receipts.generateCustomer(tenant.tenantId, saleId, null);
  return result.printJob.html ?? '';
}

/**
 * Force a status directly.
 *
 * The transitions themselves are covered where they belong — returns and voids
 * have their own specs. What is under test here is what the RECEIPT does with a
 * status, so the status is set rather than performed.
 */
async function setStatus(saleId: string, status: 'REFUNDED' | 'VOIDED' | 'DRAFT') {
  await prisma.sale.update({ where: { id: saleId }, data: { status } });
}

describe('a sale that took money keeps its receipt', () => {
  it('reprints a COMPLETED sale', async () => {
    const sale = await paidSale();

    const html = await receiptHtml(sale.id);

    expect(html).toContain(sale.saleNumber);
  });

  it('reprints a FULLY REFUNDED sale — the cliff this removed', async () => {
    // The exact case every exchange produces. Before 2026-09-08 this threw.
    const sale = await paidSale();
    await setStatus(sale.id, 'REFUNDED');

    const html = await receiptHtml(sale.id);

    expect(html).toContain(sale.saleNumber);
  });

  it('reprints a VOIDED sale', async () => {
    const sale = await paidSale();
    await setStatus(sale.id, 'VOIDED');

    const html = await receiptHtml(sale.id);

    expect(html).toContain(sale.saleNumber);
  });
});

describe('a held basket has no receipt', () => {
  it('refuses a DRAFT sale', async () => {
    /*
     * The negative half, and it is doing real work: without it, every
     * assertion above would pass for a service that had simply stopped
     * checking status — which would print a receipt for a basket nobody has
     * paid for. A hold takes no money, so there is no transaction to document.
     */
    const sale = await paidSale();
    await setStatus(sale.id, 'DRAFT');

    await expect(receiptHtml(sale.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('says WHY, in words a cashier can act on', async () => {
    // The old message named the rule ("only available for completed sales")
    // rather than the situation. The till shows this verbatim.
    const sale = await paidSale();
    await setStatus(sale.id, 'DRAFT');

    await expect(receiptHtml(sale.id)).rejects.toThrow(/on hold/i);
  });
});

/**
 * Requirement 1 (2026-09-08) — the SKU is internal and stays off the bill.
 *
 * It used to print under every item name on the 80mm receipt. A customer has no
 * use for it and the width it costs on an 80mm slip is real.
 *
 * The pair of assertions is the point: absent from the PRINTED document, still
 * present on the product. A test for the absence alone would pass for a change
 * that had deleted the SKU from the system, which is the opposite of what was
 * asked.
 */
describe('the SKU does not reach the customer bill', () => {
  it('the product still HAS a SKU', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: tenant.productAId },
    });

    expect(product.sku).toBeTruthy();
  });

  it('and the receipt does not print it', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: tenant.productAId },
    });
    const sale = await paidSale();

    const html = await receiptHtml(sale.id);

    // The line is on the receipt...
    expect(html).toContain(product.name);
    // ...and its SKU is not.
    expect(html).not.toContain(product.sku!);
  });

  it('still stores the SKU on the receipt RECORD', async () => {
    /*
     * The archive is not the document. `toReceiptContent` freezes the line data
     * as the receipt's permanent record, and dropping the SKU from it would be
     * a data change wearing a display fix's clothes — a reprint years later
     * would know less about the sale than the original did.
     */
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: tenant.productAId },
    });
    const sale = await paidSale();
    await receipts.generateCustomer(tenant.tenantId, sale.id, null);

    const receipt = await prisma.receipt.findFirstOrThrow({ where: { saleId: sale.id } });

    expect(JSON.stringify(receipt.content)).toContain(product.sku!);
  });
});

describe('a voided receipt is stamped', () => {
  it('prints VOID across a voided sale', async () => {
    const sale = await paidSale();
    await setStatus(sale.id, 'VOIDED');

    const html = await receiptHtml(sale.id);

    expect(html).toContain('VOID');
    // The reason the reprint is allowed at all is the paper trail, so the
    // document has to disclaim itself rather than merely carry a word.
    expect(html).toMatch(/not valid as proof of purchase/i);
  });

  it('does NOT stamp a live sale', async () => {
    // The negative control. A stamp on every receipt would pass the assertion
    // above while making every real receipt worthless.
    const sale = await paidSale();

    const html = await receiptHtml(sale.id);

    expect(html).not.toMatch(/not valid as proof of purchase/i);
    expect(html).not.toContain('>VOID<');
  });

  it('does NOT stamp a refunded sale', async () => {
    /*
     * A refund and a void are different facts. The goods came back and the
     * money was returned, but the sale genuinely happened — stamping it would
     * misrepresent a legitimate transaction, and the customer's own copy says
     * nothing of the sort.
     */
    const sale = await paidSale();
    await setStatus(sale.id, 'REFUNDED');

    const html = await receiptHtml(sale.id);

    expect(html).not.toMatch(/not valid as proof of purchase/i);
  });
});
