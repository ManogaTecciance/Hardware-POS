import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PaymentsRepository } from './payments.repository';

/**
 * Credit is settled per ACCOUNT, not per invoice, so these pin the two things
 * that rule turns on: a part payment must leave every invoice on credit, and the
 * moment the account clears, every invoice outstanding AT THAT MOMENT must be
 * covered — and no later one.
 *
 * The fake below stands in for Prisma and applies the same semantics the real
 * `where` clauses do: a sale is owing while it is COMPLETED, unpaid or partly
 * paid, and not yet settled; a payment counts while it is an account payment
 * that has not been consumed.
 */
interface FakeSale {
  id: string;
  status: string;
  paymentStatus: string;
  balanceAmount: number;
  creditSettledAt: Date | null;
  markedPaidAt: Date | null;
  markedPaidByUserId: string | null;
  customerId: string;
}
interface FakePayment {
  id: string;
  customerId: string | null;
  saleId: string | null;
  amount: number;
  settledAt: Date | null;
  reference?: string | null;
}

function fakePrisma(sales: FakeSale[], customerExists = true) {
  const payments: FakePayment[] = [];
  const owing = (customerId: string) =>
    sales.filter(
      (s) =>
        s.customerId === customerId &&
        s.status === 'COMPLETED' &&
        ['UNPAID', 'PARTIAL'].includes(s.paymentStatus) &&
        s.creditSettledAt === null,
    );
  const unsettled = (customerId: string) =>
    payments.filter((p) => p.customerId === customerId && p.saleId === null && p.settledAt === null);

  const tx = {
    customer: {
      findFirst: jest.fn(async () => (customerExists ? { id: 'cus_1' } : null)),
    },
    sale: {
      aggregate: jest.fn(async ({ where }: { where: { customerId: string } }) => ({
        _sum: { balanceAmount: owing(where.customerId).reduce((t, s) => t + s.balanceAmount, 0) },
      })),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { customerId: string; markedPaidAt?: null };
          data: Partial<FakeSale>;
        }) => {
          // `markedPaidAt: null` in the where narrows to the invoices nobody has
          // accounted for yet — the ones the sweep stamps with its own marker.
          const hit = owing(where.customerId).filter(
            (s) => where.markedPaidAt === undefined || s.markedPaidAt === null,
          );
          hit.forEach((s) => Object.assign(s, data));
          return { count: hit.length };
        },
      ),
    },
    payment: {
      aggregate: jest.fn(async ({ where }: { where: { customerId: string } }) => ({
        _sum: { amount: unsettled(where.customerId).reduce((t, p) => t + p.amount, 0) },
      })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `pay_${payments.length + 1}`, settledAt: null, ...data } as FakePayment;
        payments.push(row);
        return row;
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: { customerId: string }; data: { settledAt: Date } }) => {
          const hit = unsettled(where.customerId);
          hit.forEach((p) => (p.settledAt = data.settledAt));
          return { count: hit.length };
        },
      ),
    },
  };

  return {
    sales,
    payments,
    tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
}

function sale(id: string, balanceAmount: number, over: Partial<FakeSale> = {}): FakeSale {
  return {
    id,
    status: 'COMPLETED',
    paymentStatus: 'UNPAID',
    balanceAmount,
    creditSettledAt: null,
    markedPaidAt: null,
    markedPaidByUserId: null,
    customerId: 'cus_1',
    ...over,
  };
}

const base = { tenantId: 't1', customerId: 'cus_1', receivedByUserId: 'u1', method: 'CASH' as const };

function repo(prisma: ReturnType<typeof fakePrisma>) {
  return new PaymentsRepository(prisma as never);
}

describe('recording a payment against a credit account', () => {
  it('leaves every invoice on credit while the account still owes', async () => {
    const prisma = fakePrisma([sale('s1', 400), sale('s2', 600)]);
    const res = await repo(prisma).recordForCustomer({ ...base, amount: 400 });
    expect(res.outstanding).toBe(600);
    expect(res.salesSettled).toBe(0);
    // The oldest invoice is NOT settled: part payment buys no invoice outright.
    expect(prisma.sales.every((s) => s.creditSettledAt === null)).toBe(true);
  });

  it('covers every outstanding invoice at once when the account clears', async () => {
    const prisma = fakePrisma([sale('s1', 400), sale('s2', 600)]);
    const r = repo(prisma);
    await r.recordForCustomer({ ...base, amount: 400 });
    const res = await r.recordForCustomer({ ...base, amount: 600 });
    expect(res.outstanding).toBe(0);
    expect(res.salesSettled).toBe(2);
    expect(prisma.sales.every((s) => s.creditSettledAt !== null)).toBe(true);
  });

  it('settles in one payment when it covers the whole account', async () => {
    const prisma = fakePrisma([sale('s1', 250), sale('s2', 750)]);
    const res = await repo(prisma).recordForCustomer({ ...base, amount: 1000 });
    expect(res.salesSettled).toBe(2);
  });

  it('never rewrites what was tendered against an invoice', async () => {
    // The invoice keeps its own figures; only the settlement marker is written,
    // so the printed bill and the refund guard still read what really happened.
    const prisma = fakePrisma([sale('s1', 1000, { paymentStatus: 'PARTIAL', balanceAmount: 400 })]);
    await repo(prisma).recordForCustomer({ ...base, amount: 400 });
    expect(prisma.sales[0].balanceAmount).toBe(400);
    expect(prisma.sales[0].paymentStatus).toBe('PARTIAL');
    expect(prisma.sales[0].creditSettledAt).not.toBeNull();
  });

  it('starts the next balance from zero, not from the money that cleared the last one', async () => {
    const prisma = fakePrisma([sale('s1', 500)]);
    const r = repo(prisma);
    await r.recordForCustomer({ ...base, amount: 500 });
    // A new credit sale after settlement.
    prisma.sales.push(sale('s2', 300));
    const res = await r.recordForCustomer({ ...base, amount: 300 });
    expect(res.outstanding).toBe(0);
    // Only the new sale is swept this time; the old one was already covered.
    expect(res.salesSettled).toBe(1);
  });

  it('leaves a sale rung up after settlement on credit', async () => {
    const prisma = fakePrisma([sale('s1', 500)]);
    const r = repo(prisma);
    await r.recordForCustomer({ ...base, amount: 500 });
    prisma.sales.push(sale('s2', 300));
    expect(prisma.sales.find((s) => s.id === 's2')?.creditSettledAt).toBeNull();
  });

  it('refuses more than the account owes', async () => {
    const prisma = fakePrisma([sale('s1', 500)]);
    await expect(repo(prisma).recordForCustomer({ ...base, amount: 501 })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.payments).toHaveLength(0);
  });

  it('refuses a payment when the account is already clear', async () => {
    const prisma = fakePrisma([sale('s1', 500)]);
    const r = repo(prisma);
    await r.recordForCustomer({ ...base, amount: 500 });
    await expect(r.recordForCustomer({ ...base, amount: 1 })).rejects.toThrow(
      /nothing outstanding/i,
    );
  });

  it('refuses a payment for a customer that owes nothing at all', async () => {
    const prisma = fakePrisma([]);
    await expect(repo(prisma).recordForCustomer({ ...base, amount: 100 })).rejects.toThrow(
      /nothing outstanding/i,
    );
  });

  it('reports a customer that does not belong to this tenant', async () => {
    const prisma = fakePrisma([sale('s1', 500)], false);
    await expect(repo(prisma).recordForCustomer({ ...base, amount: 100 })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('records the payment against the customer and against no sale', async () => {
    const prisma = fakePrisma([sale('s1', 500)]);
    await repo(prisma).recordForCustomer({
      ...base,
      amount: 100,
      method: 'BANK_TRANSFER',
      reference: 'TRF-77',
    });
    expect(prisma.payments[0]).toMatchObject({
      customerId: 'cus_1',
      saleId: null,
      amount: 100,
      method: 'BANK_TRANSFER',
      reference: 'TRF-77',
      receivedByUserId: 'u1',
    });
  });

  it('stores a null reference rather than undefined when none is given', async () => {
    const prisma = fakePrisma([sale('s1', 500)]);
    await repo(prisma).recordForCustomer({ ...base, amount: 100 });
    expect(prisma.payments[0].reference).toBeNull();
  });

  it('recomputes the balance inside the transaction, so a race cannot overpay', async () => {
    const prisma = fakePrisma([sale('s1', 500)]);
    const r = repo(prisma);
    await r.recordForCustomer({ ...base, amount: 500 });
    await expect(r.recordForCustomer({ ...base, amount: 1 })).rejects.toThrow(
      /nothing outstanding/i,
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('keeps the arithmetic exact to the cent across instalments', async () => {
    const prisma = fakePrisma([sale('s1', 100.1)]);
    const r = repo(prisma);
    await r.recordForCustomer({ ...base, amount: 33.37 });
    await r.recordForCustomer({ ...base, amount: 33.37 });
    // 0.1 + 33.37 drifts in floating point; the account balance must not.
    const res = await r.recordForCustomer({ ...base, amount: 33.36 });
    expect(res.outstanding).toBe(0);
    expect(res.salesSettled).toBe(1);
  });

  it('ignores till payments when working out what the account owes', async () => {
    // A sale part-paid at the counter already reduced its own balanceAmount; its
    // payment row must not be subtracted a second time here.
    const prisma = fakePrisma([sale('s1', 400, { paymentStatus: 'PARTIAL' })]);
    prisma.payments.push({ id: 'till', customerId: null, saleId: 's1', amount: 600, settledAt: null });
    const res = await repo(prisma).recordForCustomer({ ...base, amount: 400 });
    expect(res.outstanding).toBe(0);
  });
});


/**
 * Clearing an account is itself an act of accounting for every invoice on it.
 *
 * The invoices that still had a Mark paid button are stamped with the moment the
 * account came square and the person who took the money, so the customer page
 * reads the same whether a user ticked an invoice off or the payment did it.
 */
describe('what clearing an account records on its invoices', () => {
  it('stamps every unaccounted invoice with the payment and its taker', async () => {
    const prisma = fakePrisma([sale('s1', 400), sale('s2', 600)]);
    const res = await repo(prisma).recordForCustomer({ ...base, amount: 1000 });

    expect(res.salesSettled).toBe(2);
    for (const s of prisma.sales) {
      expect(s.markedPaidAt).toEqual(s.creditSettledAt);
      expect(s.markedPaidByUserId).toBe('u1');
    }
  });

  it('leaves an invoice someone already ticked off in their name', async () => {
    // They accounted for it; the payment settles it but does not take the credit.
    const theirs = new Date('2026-01-01T10:00:00Z');
    const prisma = fakePrisma([
      sale('s1', 400, { markedPaidAt: theirs, markedPaidByUserId: 'u9' }),
      sale('s2', 600),
    ]);
    await repo(prisma).recordForCustomer({ ...base, amount: 1000 });

    const already = prisma.sales.find((s) => s.id === 's1');
    expect(already?.markedPaidAt).toBe(theirs);
    expect(already?.markedPaidByUserId).toBe('u9');
    // ...and it is still settled by the payment.
    expect(already?.creditSettledAt).not.toBeNull();

    const swept = prisma.sales.find((s) => s.id === 's2');
    expect(swept?.markedPaidByUserId).toBe('u1');
  });

  it('counts both the stamped and the already-ticked invoices as settled', async () => {
    const prisma = fakePrisma([
      sale('s1', 300, { markedPaidAt: new Date(), markedPaidByUserId: 'u9' }),
      sale('s2', 300),
      sale('s3', 400),
    ]);
    const res = await repo(prisma).recordForCustomer({ ...base, amount: 1000 });
    expect(res.salesSettled).toBe(3);
  });

  it('does not stamp a part payment that leaves the account short', async () => {
    const prisma = fakePrisma([sale('s1', 400), sale('s2', 600)]);
    await repo(prisma).recordForCustomer({ ...base, amount: 400 });
    expect(prisma.sales.every((s) => s.markedPaidAt === null)).toBe(true);
  });
});
