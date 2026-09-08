import { test, expect } from '../src/fixtures';
import { Api } from '../src/api';

/**
 * Ticking a credit invoice off on the customer page.
 *
 * It is bookkeeping: it records who accounted for an invoice and when, and moves
 * no money. The rule that matters is the last one — ticking every invoice is what
 * would make an account read as dealt with, so the final tick has to be earned by
 * recorded payments.
 */
test.describe('MARK — accounting for a credit invoice', () => {
  const DUE = Api.daysAhead(30);

  async function creditSale(api: Api, customerId?: string, unitPrice = 10_000) {
    const product = await api.createProduct({ quantityOnHand: 1000, unitPrice });
    const total = await api.cartTotal([{ productId: product.id, quantity: 1 }]);
    const id =
      customerId ??
      (await api.createCustomer({ creditAllowed: true, creditLimit: total * 100 })).id;
    const sale = await api.post('/sales/complete', {
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      customerId: id,
      items: [{ productId: product.id, quantity: 1 }],
      payments: [],
      paymentDueDate: DUE,
    });
    return { customerId: id, sale, total };
  }

  const mark = (api: Api, saleId: string, marked: boolean) =>
    api.postRaw(`/sales/${saleId}/marked-paid`, { marked });

  test('MARK-001 an invoice records who ticked it and when', async ({ ownerApi }) => {
    const first = await creditSale(ownerApi);
    await creditSale(ownerApi, first.customerId); // so the first is not the last

    const res = await mark(ownerApi, first.sale.id, true);
    expect(res.ok()).toBeTruthy();

    const page = await ownerApi.get(
      `/sales?page=1&pageSize=50&customerId=${first.customerId}`,
    );
    const row = page.items.find((s: any) => s.id === first.sale.id);
    expect(row.markedPaidAt).toBeTruthy();
    expect(row.markedPaidByName).toBeTruthy();
  });

  test('MARK-002 ticking moves no money', async ({ ownerApi }) => {
    const first = await creditSale(ownerApi);
    await creditSale(ownerApi, first.customerId);
    const before = await ownerApi.get(`/customers/${first.customerId}/credit`);

    await mark(ownerApi, first.sale.id, true);

    const after = await ownerApi.get(`/customers/${first.customerId}/credit`);
    expect(Number(after.outstanding)).toBe(Number(before.outstanding));
    const detail = await ownerApi.get(`/sales/${first.sale.id}`);
    expect(Number(detail.balanceAmount)).toBe(Number(first.total));
    expect(detail.paymentStatus).not.toBe('PAID');
  });

  test('MARK-003 the last uncovered invoice cannot be ticked while the account owes', async ({
    ownerApi,
  }) => {
    const first = await creditSale(ownerApi);
    const second = await creditSale(ownerApi, first.customerId);

    expect((await mark(ownerApi, first.sale.id, true)).ok()).toBeTruthy();

    const res = await mark(ownerApi, second.sale.id, true);
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('last invoice');
  });

  test('MARK-004 a single credit invoice cannot be ticked on its own', async ({ ownerApi }) => {
    // It is both the first and the last, so the rule bites immediately.
    const only = await creditSale(ownerApi);
    const res = await mark(ownerApi, only.sale.id, true);
    expect(res.status()).toBe(400);
  });

  test('MARK-005 clearing the account settles what was left, without ticking', async ({
    ownerApi,
  }) => {
    const first = await creditSale(ownerApi);
    const second = await creditSale(ownerApi, first.customerId);
    await mark(ownerApi, first.sale.id, true);

    const owed = Number((await ownerApi.get(`/customers/${first.customerId}/credit`)).outstanding);
    await ownerApi.post('/payments', {
      customerId: first.customerId,
      method: 'CASH',
      amount: owed,
    });

    // Both are covered now — the one that was ticked, and the one that was not.
    for (const s of [first.sale, second.sale]) {
      expect((await ownerApi.get(`/sales/${s.id}`)).creditSettledAt).not.toBeNull();
    }
  });

  test('MARK-015 clearing the account accounts for every invoice left', async ({ ownerApi }) => {
    // The invoices that still had a Mark paid button are stamped with the moment
    // the account came square and the person who took the money.
    const first = await creditSale(ownerApi);
    const second = await creditSale(ownerApi, first.customerId);

    const owed = Number((await ownerApi.get(`/customers/${first.customerId}/credit`)).outstanding);
    await ownerApi.post('/payments', {
      customerId: first.customerId,
      method: 'CASH',
      amount: owed,
    });

    const page = await ownerApi.get(`/sales?page=1&pageSize=50&customerId=${first.customerId}`);
    for (const id of [first.sale.id, second.sale.id]) {
      const row = page.items.find((s: any) => s.id === id);
      expect(row.markedPaidAt).toBeTruthy();
      expect(row.markedPaidByName).toBeTruthy();
      // Stamped with the settlement itself, not some later moment.
      expect(row.markedPaidAt).toBe(row.creditSettledAt);
    }
  });

  // The second user is the cashier rather than the manager: the manager demo user
  // was retired on the feature side (2026-08-17). Any second user holding
  // payment:create makes the point — the tick keeps its first author.
  test('MARK-016 an invoice already ticked keeps whoever ticked it', async ({
    ownerApi,
    cashierApi,
  }) => {
    // The manager accounted for one; the owner then takes the money. The
    // settlement must not take credit for the manager's tick.
    const first = await creditSale(ownerApi);
    const second = await creditSale(ownerApi, first.customerId);
    await cashierApi.post(`/sales/${first.sale.id}/marked-paid`, { marked: true });

    const before = await ownerApi.get(`/sales/${first.sale.id}`);
    const owed = Number((await ownerApi.get(`/customers/${first.customerId}/credit`)).outstanding);
    await ownerApi.post('/payments', {
      customerId: first.customerId,
      method: 'CASH',
      amount: owed,
    });

    const page = await ownerApi.get(`/sales?page=1&pageSize=50&customerId=${first.customerId}`);
    const ticked = page.items.find((s: any) => s.id === first.sale.id);
    const swept = page.items.find((s: any) => s.id === second.sale.id);

    expect(ticked.markedPaidAt).toBe(before.markedPaidAt);
    expect(ticked.markedPaidByName).toBe(before.markedPaidBy?.name ?? ticked.markedPaidByName);
    // ...and it is settled by the payment all the same.
    expect(ticked.creditSettledAt).toBeTruthy();
    // The one nobody touched is stamped by the settlement.
    expect(swept.markedPaidAt).toBe(swept.creditSettledAt);
  });

  test('MARK-017 a part payment accounts for nothing', async ({ ownerApi }) => {
    const first = await creditSale(ownerApi);
    await creditSale(ownerApi, first.customerId);
    const owed = Number((await ownerApi.get(`/customers/${first.customerId}/credit`)).outstanding);
    await ownerApi.post('/payments', {
      customerId: first.customerId,
      method: 'CASH',
      amount: Math.round((owed / 2) * 100) / 100,
    });

    const page = await ownerApi.get(`/sales?page=1&pageSize=50&customerId=${first.customerId}`);
    expect(page.items.every((s: any) => s.markedPaidAt === null)).toBe(true);
  });

  test('MARK-018 a ticked invoice reads as paid on the sales list', async ({ ownerApi }) => {
    // The customer page and the sales page must agree about the same invoice.
    const first = await creditSale(ownerApi);
    await creditSale(ownerApi, first.customerId);
    await mark(ownerApi, first.sale.id, true);

    const page = await ownerApi.get(`/sales?page=1&pageSize=50&search=${first.sale.saleNumber}`);
    const row = page.items.find((s: any) => s.id === first.sale.id);
    expect(row.markedPaidAt).toBeTruthy();

    // ...and the filters agree with the badge, rather than contradicting it.
    const paid = await ownerApi.get(
      `/sales?page=1&pageSize=200&paymentStatus=PAID&customerId=${first.customerId}`,
    );
    expect(paid.items.map((s: any) => s.id)).toContain(first.sale.id);

    const credit = await ownerApi.get(
      `/sales?page=1&pageSize=200&paymentStatus=UNPAID&customerId=${first.customerId}`,
    );
    expect(credit.items.map((s: any) => s.id)).not.toContain(first.sale.id);
  });

  test('MARK-019 a ticked invoice is no longer overdue', async ({ ownerApi }) => {
    const first = await creditSale(ownerApi);
    await creditSale(ownerApi, first.customerId);
    await mark(ownerApi, first.sale.id, true);
    const page = await ownerApi.get('/sales?page=1&pageSize=200&overdue=true');
    expect(page.items.map((s: any) => s.id)).not.toContain(first.sale.id);
  });

  test('MARK-020 the sale detail carries who ticked it', async ({ ownerApi }) => {
    const first = await creditSale(ownerApi);
    await creditSale(ownerApi, first.customerId);
    await mark(ownerApi, first.sale.id, true);
    const detail = await ownerApi.get(`/sales/${first.sale.id}`);
    expect(detail.markedPaidAt).toBeTruthy();
    expect(detail.markedPaidBy?.name).toBeTruthy();
  });

  test('MARK-006 a tick can be undone', async ({ ownerApi }) => {
    const first = await creditSale(ownerApi);
    await creditSale(ownerApi, first.customerId);
    await mark(ownerApi, first.sale.id, true);

    expect((await mark(ownerApi, first.sale.id, false)).ok()).toBeTruthy();
    const detail = await ownerApi.get(`/sales/${first.sale.id}`);
    expect(detail.markedPaidAt).toBeNull();
  });

  test('MARK-007 a sale already paid at the till cannot be ticked', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 500 });
    const sale = await ownerApi.completeSale([{ productId: p.id, quantity: 1 }]);
    const res = await mark(ownerApi, sale.id, true);
    expect(res.status()).toBe(400);
  });

  test('MARK-008 the invoice list is scoped to the customer', async ({ ownerApi }) => {
    const mine = await creditSale(ownerApi);
    const theirs = await creditSale(ownerApi);
    const page = await ownerApi.get(`/sales?page=1&pageSize=100&customerId=${mine.customerId}`);
    const ids = page.items.map((s: any) => s.id);
    expect(ids).toContain(mine.sale.id);
    expect(ids).not.toContain(theirs.sale.id);
  });
});
