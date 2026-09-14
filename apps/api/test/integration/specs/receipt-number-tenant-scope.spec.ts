/**
 * D171 — two tenants may both print a receipt for their own sale S-000001.
 *
 * ## The defect this closes
 *
 * `Receipt.receiptNumber` was `String @unique` — globally. The value is built as
 * `RCP-${sale.saleNumber}`, and `Sale` is `@@unique([tenantId, saleNumber])`, so
 * every tenant's numbering restarts at S-000001.
 *
 * The first tenant to print therefore claimed `RCP-S-000001` for the whole
 * installation, and every other tenant printing its own first sale hit a P2002
 * that surfaced as a **hard 500 at the till**. On the development database when
 * this was found, S-000001, S-000002 and S-000003 each existed in FOUR tenants
 * with exactly ONE receipt printed between them.
 *
 * ## Why this runs against real PostgreSQL
 *
 * The defect is a constraint defect. It lives in an index, not in a branch: a
 * mocked Prisma raises whatever the mock is told to raise, and would have passed
 * against the broken schema and the fixed one alike. Only a real unique index
 * can fail this test, which is the point of it.
 *
 * ## What makes these assertions non-vacuous (D30)
 *
 * The positive case — both prints succeed — would also pass if the constraint
 * had simply been DROPPED and never replaced. So it is paired with the negative:
 * within ONE tenant the number is still unique, asserted by writing a duplicate
 * directly and requiring P2002. A test that only proved "two tenants can print"
 * would green-light removing the guarantee altogether.
 *
 * The numbers are asserted as an exact pair, equal to each other AND equal to
 * `RCP-S-000001`. Asserting only that two receipts exist would pass for an
 * implementation that had quietly started numbering receipts globally — which
 * would fix the 500 by changing what a receipt is called, and the number on a
 * customer's receipt would stop matching the sale it belongs to.
 *
 * ## Mutation proof
 *
 * | Mutation | Fails |
 * |---|---|
 * | restore the global `@unique` on `receiptNumber` | "both tenants print their own S-000001" |
 * | drop the composite unique and add nothing | "a duplicate within one tenant is still refused" |
 * | number receipts globally instead of per sale | "the number follows the tenant's own sale number" |
 * | write `tenantId` from something other than the sale | "a receipt belongs to the tenant of its sale" |
 */
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
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
import { seedTileShopWithQuickBooks, seedSecondTenant, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let sales: SalesService;
let receipts: ReceiptsService;
let first: SeededTenant;
let second: SeededTenant;

function ownerOf(tenant: SeededTenant): AuthenticatedUser {
  return { id: tenant.ownerId, tenantId: tenant.tenantId, role: 'OWNER', activeBranchId: null };
}

async function sellOnce(tenant: SeededTenant) {
  return sales.complete(tenant.tenantId, ownerOf(tenant), {
    branchId: tenant.branchId,
    registerId: tenant.registerId,
    items: [{ productId: tenant.productAId, quantity: 1 }],
    payments: [{ method: 'CASH', amount: 1000 }],
  });
}

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
  first = await seedTileShopWithQuickBooks(prisma);
  second = await seedSecondTenant(prisma);
});

describe('D171 — a receipt number is unique per tenant, not globally', () => {
  it('both tenants print their own S-000001, and the numbers are identical', async () => {
    const saleA = await sellOnce(first);
    const saleB = await sellOnce(second);

    // The premise. If numbering were ever made global this would drift and the
    // rest of the test would be asserting something else entirely.
    expect(saleA.saleNumber).toBe('S-000001');
    expect(saleB.saleNumber).toBe('S-000001');

    const printedA = await receipts.generateCustomer(first.tenantId, saleA.id, first.ownerId);
    // Before D171 the next line threw P2002 and the till saw a 500.
    const printedB = await receipts.generateCustomer(second.tenantId, saleB.id, second.ownerId);

    expect(printedA.receiptNumber).toBe('RCP-S-000001');
    expect(printedB.receiptNumber).toBe('RCP-S-000001');
  });

  it('the number follows the tenant’s own sale number', async () => {
    // Two sales in the FIRST tenant, one in the second. The second tenant's
    // receipt must read S-000001, not S-000003: numbering is per tenant, and a
    // receipt that borrowed a global counter would be unreachable from its sale.
    await sellOnce(first);
    const saleA2 = await sellOnce(first);
    const saleB = await sellOnce(second);

    expect(saleA2.saleNumber).toBe('S-000002');
    expect(saleB.saleNumber).toBe('S-000001');

    const printedA2 = await receipts.generateCustomer(first.tenantId, saleA2.id, first.ownerId);
    const printedB = await receipts.generateCustomer(second.tenantId, saleB.id, second.ownerId);

    expect(printedA2.receiptNumber).toBe('RCP-S-000002');
    expect(printedB.receiptNumber).toBe('RCP-S-000001');
  });

  it('a receipt belongs to the tenant of its sale', async () => {
    const saleA = await sellOnce(first);
    const saleB = await sellOnce(second);
    await receipts.generateCustomer(first.tenantId, saleA.id, first.ownerId);
    await receipts.generateCustomer(second.tenantId, saleB.id, second.ownerId);

    const rows = await prisma.receipt.findMany({
      where: { receiptNumber: 'RCP-S-000001' },
      select: { tenantId: true, saleId: true },
      orderBy: { tenantId: 'asc' },
    });

    // EXACT SET, not a count: two rows with the same tenant would also be "2".
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(
      new Set([first.tenantId, second.tenantId]),
    );

    // The denormalised column must agree with the sale it hangs off. A receipt
    // carrying the wrong tenant would be invisible to its own workspace and
    // would consume a number in someone else's.
    for (const row of rows) {
      const sale = await prisma.sale.findUniqueOrThrow({
        where: { id: row.saleId },
        select: { tenantId: true },
      });
      expect(row.tenantId).toBe(sale.tenantId);
    }
  });

  it('a duplicate within one tenant is still refused', async () => {
    const saleA = await sellOnce(first);
    await receipts.generateCustomer(first.tenantId, saleA.id, first.ownerId);

    // A second sale in the SAME tenant, forced to reuse the first receipt's
    // number. Nothing in the application does this; the point is that the
    // database still refuses it, so D171 loosened the constraint rather than
    // removing it.
    const saleA2 = await sellOnce(first);
    await expect(
      prisma.receipt.create({
        data: {
          tenantId: first.tenantId,
          saleId: saleA2.id,
          receiptNumber: 'RCP-S-000001',
          printCount: 0,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a reprint does not consume a second number', async () => {
    const saleA = await sellOnce(first);

    const one = await receipts.generateCustomer(first.tenantId, saleA.id, first.ownerId);
    const two = await receipts.generateCustomer(first.tenantId, saleA.id, first.ownerId);

    expect(one.receiptNumber).toBe(two.receiptNumber);

    const rows = await prisma.receipt.findMany({ where: { saleId: saleA.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.printCount).toBe(2);
  });
});
