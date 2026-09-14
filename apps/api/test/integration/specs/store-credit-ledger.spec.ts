/**
 * D175 — store credit is a ledger the shop can read.
 *
 * ## What this closes
 *
 * `refundMethod = 'STORE_CREDIT'` was a LABEL on a return and nothing else. No
 * table recorded what the shop then owed; the customer screen's "Available
 * credit" is a different figure entirely (`creditLimit - outstandingCredit`,
 * how much the customer may buy ON ACCOUNT); and nothing checked a balance when
 * store credit was tendered on a sale.
 *
 * ## Why this runs against real PostgreSQL
 *
 * The guarantee being made is that the ledger entry lands **in the same
 * transaction as the return**. A mocked repository cannot demonstrate that: it
 * would record the call whether or not the write was ever committed, which is
 * precisely the failure mode — a return that moved money and then failed to
 * credit the customer, invisibly, because the refund slip still printed.
 *
 * The duplicate guard is a UNIQUE INDEX. Only a real database can refuse it.
 *
 * ## What makes these non-vacuous (D30)
 *
 * The balance is asserted as a NUMBER after specific movements, not merely as
 * "some entries exist". An implementation that wrote an entry with the wrong
 * sign would satisfy "the ledger has a row" and leave the shop owing money it
 * believes it has collected.
 *
 * Every positive case is paired with its negative. A CASH return is asserted to
 * write NOTHING — without that, "a return writes a ledger entry" would pass for
 * an implementation that credited every refund regardless of method, which
 * would invent liabilities out of ordinary cash refunds.
 */
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@hardware-pos/database';

import { validateEnv } from '../../../src/config/env.validation';
import { StorageModule } from '../../../src/common/storage/storage.module';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import { StoreCreditModule } from '../../../src/modules/store-credit/store-credit.module';
import { StoreCreditService } from '../../../src/modules/store-credit/store-credit.service';
import { SalesModule } from '../../../src/modules/sales/sales.module';
import { SalesService } from '../../../src/modules/sales/sales.service';
import { ReturnsModule } from '../../../src/modules/returns/returns.module';
import { ReturnsService } from '../../../src/modules/returns/returns.service';
import { CustomersModule } from '../../../src/modules/customers/customers.module';
import { CustomersService } from '../../../src/modules/customers/customers.service';
import { CreateReturnDto } from '../../../src/modules/returns/dto/create-return.dto';
import { ApproveReturnDto } from '../../../src/modules/returns/dto/approve-return.dto';
import type { AuthenticatedUser } from '../../../src/modules/auth/auth.types';

import { connectTestPrisma, disconnectTestPrisma } from '../prisma-test-client';
import { resetDatabase } from '../db-reset';
import { dto } from '../dto';
import { seedTileShopWithQuickBooks, MANAGER_PIN, type SeededTenant } from '../fixtures';

let prisma: PrismaClient;
let testModule: TestingModule;
let sales: SalesService;
let returns: ReturnsService;
let storeCredit: StoreCreditService;
let customers: CustomersService;
let tenant: SeededTenant;
let owner: AuthenticatedUser;

beforeAll(async () => {
  prisma = await connectTestPrisma();
  testModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      StorageModule,
      StoreCreditModule,
      PrismaModule,
      SalesModule,
      ReturnsModule,
      CustomersModule,
    ],
  }).compile();
  testModule.useLogger(false);
  await testModule.init();

  sales = testModule.get(SalesService);
  returns = testModule.get(ReturnsService);
  storeCredit = testModule.get(StoreCreditService);
  customers = testModule.get(CustomersService);
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

/** A paid sale with a saved customer — store credit requires one. */
function paidSaleWithCustomer() {
  return sales.complete(tenant.tenantId, owner, {
    branchId: tenant.branchId,
    customerId: tenant.creditCustomerId,
    items: [{ productId: tenant.productAId, quantity: 2 }],
    payments: [{ method: 'CASH', amount: 2000 }],
  });
}

async function returnOneUnit(saleId: string, refundMethod: string) {
  const saleItem = await prisma.saleItem.findFirstOrThrow({ where: { saleId } });
  const approval = await returns.approve(
    tenant.tenantId,
    dto(ApproveReturnDto, { managerPin: MANAGER_PIN, originalSaleId: saleId, refundTotal: 1000 }),
  );
  return returns.complete(
    tenant.tenantId,
    owner,
    dto(CreateReturnDto, {
      originalSaleId: saleId,
      refundMethod,
      ...(approval.approvalToken ? { approvalToken: approval.approvalToken } : {}),
      items: [
        {
          saleItemId: saleItem.id,
          returnQuantity: 1,
          returnReason: 'CHANGED_MIND',
          itemCondition: 'GOOD',
          stockDisposition: 'RETURN_TO_STOCK',
        },
      ],
    }),
    null,
  );
}

describe('D175 — a store-credit return credits the customer', () => {
  it('writes one entry, for the refund total, against the sale’s customer', async () => {
    const sale = await paidSaleWithCustomer();

    const ret = await returnOneUnit(sale.id, 'STORE_CREDIT');

    const entries = await prisma.storeCreditEntry.findMany({
      where: { tenantId: tenant.tenantId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      customerId: tenant.creditCustomerId,
      returnId: ret.id,
      reason: 'RETURN_REFUND',
      saleId: null,
    });
    // The AMOUNT, not just the row. A sign error would satisfy "an entry exists"
    // and leave the shop owing money it believes it has collected.
    expect(Number(entries[0]!.amount)).toBe(Number(ret.refundTotal));
    expect(Number(entries[0]!.amount)).toBeGreaterThan(0);
  });

  it('the balance is what the shop owes', async () => {
    const sale = await paidSaleWithCustomer();
    const ret = await returnOneUnit(sale.id, 'STORE_CREDIT');

    const balance = await storeCredit.balanceFor(tenant.tenantId, tenant.creditCustomerId);
    expect(balance).toBe(Number(ret.refundTotal));
  });

  it('a CASH return writes NOTHING', async () => {
    // The negative half. Without it, "a return credits the customer" would pass
    // for an implementation that credited every refund method, inventing a
    // liability out of an ordinary cash refund.
    const sale = await paidSaleWithCustomer();

    await returnOneUnit(sale.id, 'CASH');

    expect(await prisma.storeCreditEntry.count({ where: { tenantId: tenant.tenantId } })).toBe(0);
    expect(await storeCredit.balanceFor(tenant.tenantId, tenant.creditCustomerId)).toBe(0);
  });

  it('two store-credit returns accumulate', async () => {
    const a = await paidSaleWithCustomer();
    const b = await paidSaleWithCustomer();

    const first = await returnOneUnit(a.id, 'STORE_CREDIT');
    const second = await returnOneUnit(b.id, 'STORE_CREDIT');

    const balance = await storeCredit.balanceFor(tenant.tenantId, tenant.creditCustomerId);
    expect(balance).toBe(Number(first.refundTotal) + Number(second.refundTotal));
  });

  it('the customer screen shows it, separately from what they may spend', async () => {
    const sale = await paidSaleWithCustomer();
    const ret = await returnOneUnit(sale.id, 'STORE_CREDIT');

    const view = await customers.storeCreditFor(tenant.tenantId, tenant.creditCustomerId);
    expect(view.balance).toBe(Number(ret.refundTotal));
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]?.reason).toBe('RETURN_REFUND');

    // And the OTHER figure is untouched: `available` is the customer's
    // borrowing headroom and has nothing to do with what the shop owes them.
    // Confusing the two is what prompted this decision.
    const credit = await customers.creditFor(tenant.tenantId, tenant.creditCustomerId);
    expect(credit.outstanding).toBe(0);
  });

  it('the list column carries the balance too', async () => {
    const sale = await paidSaleWithCustomer();
    const ret = await returnOneUnit(sale.id, 'STORE_CREDIT');

    const page = await customers.list(tenant.tenantId, dto(Object, { page: 1, pageSize: 50 }) as never);
    const row = page.items.find((c) => c.id === tenant.creditCustomerId);
    expect(row?.storeCreditBalance).toBe(Number(ret.refundTotal));

    // Zero, not undefined, for a customer who has never been given any: "none"
    // is a real answer and must not read as "this screen does not know".
    const others = page.items.filter((c) => c.id !== tenant.creditCustomerId);
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) expect(other.storeCreditBalance).toBe(0);
  });
});

describe('D175 — spending store credit', () => {
  async function creditedCustomer(): Promise<number> {
    const sale = await paidSaleWithCustomer();
    const ret = await returnOneUnit(sale.id, 'STORE_CREDIT');
    return Number(ret.refundTotal);
  }

  it('debits the ledger and leaves the remainder', async () => {
    const issued = await creditedCustomer();

    await prisma.$transaction((tx) =>
      storeCredit.redeemForSale(tx, {
        tenantId: tenant.tenantId,
        customerId: tenant.creditCustomerId,
        saleId: null as never,
        amount: 100,
      }),
    );

    expect(await storeCredit.balanceFor(tenant.tenantId, tenant.creditCustomerId)).toBe(
      issued - 100,
    );
  });

  it('refuses to spend more than the customer holds', async () => {
    const issued = await creditedCustomer();

    await expect(
      prisma.$transaction((tx) =>
        storeCredit.redeemForSale(tx, {
          tenantId: tenant.tenantId,
          customerId: tenant.creditCustomerId,
          saleId: null as never,
          amount: issued + 0.01,
        }),
      ),
    ).rejects.toThrow(/Store credit is/);

    // And nothing was written: a refused redemption must not leave a partial
    // entry behind, or the refusal costs the customer their balance anyway.
    expect(await storeCredit.balanceFor(tenant.tenantId, tenant.creditCustomerId)).toBe(issued);
  });

  it('refuses a customer with no credit at all', async () => {
    await expect(
      prisma.$transaction((tx) =>
        storeCredit.redeemForSale(tx, {
          tenantId: tenant.tenantId,
          customerId: tenant.creditCustomerId,
          saleId: null as never,
          amount: 1,
        }),
      ),
    ).rejects.toThrow(/Store credit is 0.00/);
  });
});

describe('D175 — the ledger cannot double-credit', () => {
  it('a second entry for the same return is refused by the database', async () => {
    const sale = await paidSaleWithCustomer();
    const ret = await returnOneUnit(sale.id, 'STORE_CREDIT');

    // The guarantee is a UNIQUE INDEX, not a code path: a retry that reached
    // the write concurrently would slip past an application-level check.
    await expect(
      prisma.storeCreditEntry.create({
        data: {
          tenantId: tenant.tenantId,
          customerId: tenant.creditCustomerId,
          returnId: ret.id,
          amount: 999,
          reason: 'RETURN_REFUND',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(await storeCredit.balanceFor(tenant.tenantId, tenant.creditCustomerId)).toBe(
      Number(ret.refundTotal),
    );
  });

  it('issueForReturn is idempotent rather than throwing', async () => {
    // A retried return has already done what it came to do; raising would turn
    // a successful retry into a failure.
    const sale = await paidSaleWithCustomer();
    const ret = await returnOneUnit(sale.id, 'STORE_CREDIT');

    await expect(
      storeCredit.issueForReturn(prisma, {
        tenantId: tenant.tenantId,
        customerId: tenant.creditCustomerId,
        returnId: ret.id,
        amount: 500,
      }),
    ).resolves.toBeUndefined();

    expect(await storeCredit.balanceFor(tenant.tenantId, tenant.creditCustomerId)).toBe(
      Number(ret.refundTotal),
    );
  });
});
