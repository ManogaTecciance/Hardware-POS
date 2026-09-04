import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PaymentsRepository } from './payments.repository';

/**
 * Recording a payment moves money, so these pin the arithmetic and the guards
 * rather than the plumbing: what the sale's balance and status become, and what
 * is refused.
 */
function fakePrisma(sale: Record<string, unknown> | null) {
  const row = sale ? { ...sale } : null;
  const created: Record<string, unknown>[] = [];
  const tx = {
    sale: {
      findFirst: jest.fn(async () => row),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(row as object, data);
        return row;
      }),
    },
    payment: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `pay_${created.length}`, ...data };
      }),
    },
  };
  return {
    row,
    created,
    tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
}

function makeSale(overrides: Record<string, unknown> = {}) {
  return { id: 'sale_1', status: 'COMPLETED', total: 1000, paidAmount: 0, ...overrides };
}

const base = { tenantId: 't1', saleId: 'sale_1', receivedByUserId: 'u1', method: 'CASH' as const };

function repo(prisma: ReturnType<typeof fakePrisma>) {
  return new PaymentsRepository(prisma as never);
}

describe('recording a payment', () => {
  it('reduces the balance and leaves the sale PARTIAL while money is still owed', async () => {
    const prisma = fakePrisma(makeSale());
    await repo(prisma).recordAgainstSale({ ...base, amount: 400 });
    expect(prisma.row).toMatchObject({ paidAmount: 400, balanceAmount: 600, paymentStatus: 'PARTIAL' });
  });

  it('marks the sale PAID once the balance reaches zero', async () => {
    const prisma = fakePrisma(makeSale({ paidAmount: 600 }));
    await repo(prisma).recordAgainstSale({ ...base, amount: 400 });
    expect(prisma.row).toMatchObject({ paidAmount: 1000, balanceAmount: 0, paymentStatus: 'PAID' });
  });

  it('accumulates across instalments', async () => {
    const prisma = fakePrisma(makeSale());
    const r = repo(prisma);
    await r.recordAgainstSale({ ...base, amount: 300 });
    await r.recordAgainstSale({ ...base, amount: 300 });
    await r.recordAgainstSale({ ...base, amount: 400 });
    expect(prisma.created).toHaveLength(3);
    expect(prisma.row).toMatchObject({ paidAmount: 1000, balanceAmount: 0, paymentStatus: 'PAID' });
  });

  it('records the payment as its own row with method and reference', async () => {
    const prisma = fakePrisma(makeSale());
    await repo(prisma).recordAgainstSale({
      ...base,
      amount: 250,
      method: 'CARD',
      reference: 'AUTH-9911',
    });
    expect(prisma.created[0]).toMatchObject({
      saleId: 'sale_1',
      amount: 250,
      method: 'CARD',
      reference: 'AUTH-9911',
      receivedByUserId: 'u1',
    });
  });

  it('stores a null reference rather than undefined when none is given', async () => {
    const prisma = fakePrisma(makeSale());
    await repo(prisma).recordAgainstSale({ ...base, amount: 100 });
    expect(prisma.created[0].reference).toBeNull();
  });

  it('refuses a payment larger than the outstanding balance', async () => {
    const prisma = fakePrisma(makeSale({ paidAmount: 900 }));
    await expect(repo(prisma).recordAgainstSale({ ...base, amount: 200 })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.created).toHaveLength(0);
  });

  it('allows a payment that settles the balance exactly', async () => {
    const prisma = fakePrisma(makeSale({ paidAmount: 900 }));
    await expect(repo(prisma).recordAgainstSale({ ...base, amount: 100 })).resolves.toBeDefined();
  });

  it('refuses a payment against an already settled sale', async () => {
    const prisma = fakePrisma(makeSale({ paidAmount: 1000 }));
    await expect(repo(prisma).recordAgainstSale({ ...base, amount: 1 })).rejects.toThrow(
      /already fully paid/i,
    );
  });

  it('refuses a payment against a draft', async () => {
    const prisma = fakePrisma(makeSale({ status: 'DRAFT' }));
    await expect(repo(prisma).recordAgainstSale({ ...base, amount: 100 })).rejects.toThrow(
      /completed sale/i,
    );
  });

  it('reports a sale that does not exist for this tenant', async () => {
    const prisma = fakePrisma(null);
    await expect(repo(prisma).recordAgainstSale({ ...base, amount: 100 })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('re-reads the balance inside the transaction, so it cannot be overpaid by a race', async () => {
    // The guard must run against the balance as it stands when the transaction
    // opens, not one the caller read earlier.
    const prisma = fakePrisma(makeSale());
    const r = repo(prisma);
    await r.recordAgainstSale({ ...base, amount: 1000 });
    await expect(r.recordAgainstSale({ ...base, amount: 1 })).rejects.toThrow(/already fully paid/i);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('keeps money arithmetic exact to the cent', async () => {
    const prisma = fakePrisma(makeSale({ total: 100.1, paidAmount: 0 }));
    const r = repo(prisma);
    await r.recordAgainstSale({ ...base, amount: 33.37 });
    await r.recordAgainstSale({ ...base, amount: 33.37 });
    // 0.1 + 33.37 arithmetic in floating point drifts; the balance must not.
    expect(prisma.row?.balanceAmount).toBe(33.36);
    await r.recordAgainstSale({ ...base, amount: 33.36 });
    expect(prisma.row).toMatchObject({ balanceAmount: 0, paymentStatus: 'PAID' });
  });
});
