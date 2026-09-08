import { test, expect } from '../src/fixtures';
import { Api } from '../src/api';

/**
 * Credit management. Credit is an ACCOUNT balance, not a per-invoice one: money
 * is received against the customer, every credit sale stays outstanding while
 * anything is still owed, and the moment the account clears, the invoices it
 * covered are all marked settled together.
 *
 * Driven through the API because these are arithmetic and guard rules — a rule
 * that only holds in the browser is not a rule.
 */
test.describe('CREDIT — accounts, due dates & settlement', () => {
  const DUE = Api.daysAhead(30);

  /** A credit customer, and one unpaid sale against their account. */
  async function creditSale(
    api: Api,
    opts: {
      creditLimit?: number | null;
      quantity?: number;
      paymentDueDate?: string;
      saleDate?: string;
      customerId?: string;
      unitPrice?: number;
    } = {},
  ) {
    const product = await api.createProduct({
      quantityOnHand: 1000,
      unitPrice: opts.unitPrice ?? 10_000,
    });
    const quantity = opts.quantity ?? 1;
    const total = await api.cartTotal([{ productId: product.id, quantity }]);
    const customerId =
      opts.customerId ??
      (
        await api.createCustomer({
          creditAllowed: true,
          creditLimit: opts.creditLimit === undefined ? total * 100 : opts.creditLimit,
        })
      ).id;
    const sale = await api.post('/sales/complete', {
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      customerId,
      items: [{ productId: product.id, quantity }],
      payments: [],
      ...(opts.saleDate ? { saleDate: opts.saleDate } : {}),
      paymentDueDate: opts.paymentDueDate ?? DUE,
    });
    return { product, customerId, sale, total };
  }

  /** Pay against a customer's credit account. */
  const payAccount = (api: Api, customerId: string, amount: number, method = 'CASH') =>
    api.post('/payments', { customerId, method, amount });

  const credit = (api: Api, customerId: string) => api.get(`/customers/${customerId}/credit`);
  const saleOf = (api: Api, id: string) => api.get(`/sales/${id}`);

  // ── Account-level settlement ───────────────────────────────────────────────

  test('PAY-019 a part payment leaves every invoice on credit', async ({ ownerApi }) => {
    const first = await creditSale(ownerApi);
    const second = await creditSale(ownerApi, { customerId: first.customerId });
    const owed = first.total + second.total;

    const res = await payAccount(ownerApi, first.customerId, Math.round(owed / 2));
    expect(Number(res.outstanding)).toBeGreaterThan(0);
    expect(res.salesSettled).toBe(0);

    // Neither invoice is settled — not even the older one.
    for (const s of [first.sale, second.sale]) {
      expect((await saleOf(ownerApi, s.id)).creditSettledAt).toBeNull();
    }
  });

  test('PAY-020 clearing the account marks every invoice on it as paid', async ({ ownerApi }) => {
    const first = await creditSale(ownerApi);
    const second = await creditSale(ownerApi, { customerId: first.customerId });
    const owed = await accountOwed(ownerApi, first.customerId);

    const res = await payAccount(ownerApi, first.customerId, owed);
    expect(Number(res.outstanding)).toBe(0);
    expect(res.salesSettled).toBe(2);

    for (const s of [first.sale, second.sale]) {
      expect((await saleOf(ownerApi, s.id)).creditSettledAt).not.toBeNull();
    }
  });

  test('PAY-034 a sale rung up after settlement starts a fresh balance', async ({ ownerApi }) => {
    const first = await creditSale(ownerApi);
    await payAccount(ownerApi, first.customerId, await accountOwed(ownerApi, first.customerId));

    const later = await creditSale(ownerApi, { customerId: first.customerId });
    expect((await saleOf(ownerApi, later.sale.id)).creditSettledAt).toBeNull();
    // The already-covered invoice is untouched by the new debt.
    expect((await saleOf(ownerApi, first.sale.id)).creditSettledAt).not.toBeNull();
    expect(Number((await credit(ownerApi, first.customerId)).outstanding)).toBeCloseTo(
      later.total,
      2,
    );
  });

  test('PAY-035 settlement never rewrites what was tendered against an invoice', async ({
    ownerApi,
  }) => {
    // The invoice's own figures must stay true: the printed bill and the refund
    // guard read them, and nothing was tendered against this invoice.
    const { sale, customerId } = await creditSale(ownerApi);
    const before = await saleOf(ownerApi, sale.id);
    await payAccount(ownerApi, customerId, await accountOwed(ownerApi, customerId));
    const after = await saleOf(ownerApi, sale.id);

    expect(Number(after.paidAmount)).toBe(Number(before.paidAmount));
    expect(Number(after.balanceAmount)).toBe(Number(before.balanceAmount));
    expect(after.payments).toHaveLength(0);
    expect(after.creditSettledAt).not.toBeNull();
  });

  test('PAY-027 each account payment is kept as its own record', async ({ ownerApi }) => {
    const { customerId, total } = await creditSale(ownerApi);
    const third = Math.floor((total / 3) * 100) / 100;
    await payAccount(ownerApi, customerId, third, 'CASH');
    await ownerApi.post('/payments', {
      customerId,
      method: 'CARD',
      amount: third,
      reference: 'AUTH-2201',
    });

    const rows = await ownerApi.get(`/payments?customerId=${customerId}`);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.createdAt).toBeTruthy();
    // Newest first.
    expect(rows[0].method).toBe('CARD');
    expect(rows[0].reference).toBe('AUTH-2201');
    expect(rows.every((r: any) => r.saleId === null)).toBe(true);
  });

  test('PAY-021 a payment larger than the account balance is rejected', async ({ ownerApi }) => {
    const { customerId } = await creditSale(ownerApi);
    const owed = await accountOwed(ownerApi, customerId);
    const res = await ownerApi.postRaw('/payments', {
      customerId,
      method: 'CASH',
      amount: owed + 1,
    });
    expect(res.status()).toBe(400);
    expect(await accountOwed(ownerApi, customerId)).toBeCloseTo(owed, 2);
  });

  test('PAY-022 a payment against a cleared account is rejected', async ({ ownerApi }) => {
    const { customerId } = await creditSale(ownerApi);
    await payAccount(ownerApi, customerId, await accountOwed(ownerApi, customerId));
    const res = await ownerApi.postRaw('/payments', { customerId, method: 'CASH', amount: 1 });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('nothing outstanding');
  });

  test('PAY-036 payments retire once they have cleared a balance', async ({ ownerApi }) => {
    // Otherwise the money would keep being subtracted and every later balance
    // would come out short.
    const first = await creditSale(ownerApi);
    await payAccount(ownerApi, first.customerId, await accountOwed(ownerApi, first.customerId));
    const later = await creditSale(ownerApi, { customerId: first.customerId });
    expect(await accountOwed(ownerApi, first.customerId)).toBeCloseTo(later.total, 2);
  });

  // ── REQ005 — payment due date (unchanged by the account model) ─────────────

  test('PAY-023 a sale that leaves a balance is refused without a due date', async ({
    ownerApi,
  }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 1000 });
    const cust = await ownerApi.createCustomer({ creditAllowed: true });
    const res = await ownerApi.postRaw('/sales/complete', {
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      customerId: cust.id,
      items: [{ productId: p.id, quantity: 1 }],
      payments: [],
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('due date');
  });

  test('PAY-024 a fully paid sale is refused a due date', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 1000 });
    const res = await ownerApi.postRaw('/sales/complete', {
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      items: [{ productId: p.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 10_000_000 }],
      paymentDueDate: DUE,
    });
    expect(res.status()).toBe(400);
  });

  test('PAY-025 the due date is stored on the sale', async ({ ownerApi }) => {
    const { sale } = await creditSale(ownerApi);
    const detail = await saleOf(ownerApi, sale.id);
    expect(String(detail.paymentDueDate).slice(0, 10)).toBe(DUE);
  });

  test('PAY-026 a due date before the invoice date is refused', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 1000 });
    const cust = await ownerApi.createCustomer({ creditAllowed: true });
    const res = await ownerApi.postRaw('/sales/complete', {
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      customerId: cust.id,
      items: [{ productId: p.id, quantity: 1 }],
      payments: [],
      paymentDueDate: Api.daysAgo(1),
    });
    expect(res.status()).toBe(400);
  });

  // ── Sales list ─────────────────────────────────────────────────────────────

  test('SALE-021 the overdue filter returns only sales past due and still owed', async ({
    ownerApi,
  }) => {
    const overdue = await creditSale(ownerApi, {
      saleDate: Api.daysAgo(5),
      paymentDueDate: Api.daysAgo(1),
    });
    const notYetDue = await creditSale(ownerApi);

    const page = await ownerApi.get('/sales?page=1&pageSize=200&overdue=true');
    const ids = page.items.map((s: any) => s.id);
    expect(ids).toContain(overdue.sale.id);
    expect(ids).not.toContain(notYetDue.sale.id);
  });

  test('SALE-022 clearing the account drops its sales from the overdue filter', async ({
    ownerApi,
  }) => {
    const { sale, customerId } = await creditSale(ownerApi, {
      saleDate: Api.daysAgo(5),
      paymentDueDate: Api.daysAgo(1),
    });
    await payAccount(ownerApi, customerId, await accountOwed(ownerApi, customerId));
    const page = await ownerApi.get('/sales?page=1&pageSize=200&overdue=true');
    expect(page.items.map((s: any) => s.id)).not.toContain(sale.id);
  });

  test('SALE-028 the Credit filter excludes sales the account has cleared', async ({
    ownerApi,
  }) => {
    const owing = await creditSale(ownerApi);
    const settled = await creditSale(ownerApi);
    await payAccount(ownerApi, settled.customerId, await accountOwed(ownerApi, settled.customerId));

    const page = await ownerApi.get('/sales?page=1&pageSize=200&paymentStatus=UNPAID');
    const ids = page.items.map((s: any) => s.id);
    expect(ids).toContain(owing.sale.id);
    expect(ids).not.toContain(settled.sale.id);
  });

  test('SALE-032 the Paid filter includes sales the account has cleared', async ({ ownerApi }) => {
    const { sale, customerId } = await creditSale(ownerApi);
    await payAccount(ownerApi, customerId, await accountOwed(ownerApi, customerId));
    const page = await ownerApi.get('/sales?page=1&pageSize=200&paymentStatus=PAID');
    expect(page.items.map((s: any) => s.id)).toContain(sale.id);
  });

  test('SALE-033 a settled sale reports when its account cleared it', async ({ ownerApi }) => {
    const { sale, customerId } = await creditSale(ownerApi);
    await payAccount(ownerApi, customerId, await accountOwed(ownerApi, customerId));
    const page = await ownerApi.get(`/sales?page=1&pageSize=50&search=${sale.saleNumber}`);
    const row = page.items.find((s: any) => s.id === sale.id);
    expect(row.creditSettledAt).toBeTruthy();
  });

  // ── Customer credit position ───────────────────────────────────────────────

  test('CUST-017 available credit is the limit minus what the account owes', async ({
    ownerApi,
  }) => {
    const { customerId, total } = await creditSale(ownerApi, { creditLimit: 100_000 });
    const c = await credit(ownerApi, customerId);
    expect(Number(c.outstanding)).toBeCloseTo(total, 2);
    expect(Number(c.available)).toBeCloseTo(100_000 - total, 2);
  });

  test('CUST-028 a part payment releases credit immediately', async ({ ownerApi }) => {
    // The invoices stay on credit, but the money is the shop's the moment it is
    // taken, so the headroom must move even before the account clears.
    const { customerId, total } = await creditSale(ownerApi, { creditLimit: 100_000 });
    const half = Math.round((total / 2) * 100) / 100;
    await payAccount(ownerApi, customerId, half);
    const c = await credit(ownerApi, customerId);
    expect(Number(c.outstanding)).toBeCloseTo(total - half, 2);
    expect(Number(c.available)).toBeCloseTo(100_000 - (total - half), 2);
  });

  test('CUST-018 a customer with no limit reports no available credit', async ({ ownerApi }) => {
    const { customerId } = await creditSale(ownerApi, { creditLimit: null });
    expect((await credit(ownerApi, customerId)).available).toBeNull();
  });

  test('CUST-019 clearing the account releases the whole limit again', async ({ ownerApi }) => {
    const { customerId } = await creditSale(ownerApi, { creditLimit: 100_000 });
    await payAccount(ownerApi, customerId, await accountOwed(ownerApi, customerId));
    const c = await credit(ownerApi, customerId);
    expect(Number(c.outstanding)).toBe(0);
    expect(Number(c.available)).toBeCloseTo(100_000, 2);
  });

  test('CUST-020 the customers list filters to those with credit outstanding', async ({
    ownerApi,
  }) => {
    const owing = await creditSale(ownerApi);
    const settled = await creditSale(ownerApi);
    await payAccount(ownerApi, settled.customerId, await accountOwed(ownerApi, settled.customerId));

    const page = await ownerApi.get(
      '/customers?page=1&pageSize=200&hasOutstandingCredit=true&isActive=true',
    );
    const ids = page.items.map((c: any) => c.id);
    expect(ids).toContain(owing.customerId);
    expect(ids).not.toContain(settled.customerId);
  });

  test('CUST-024 the figure the till shows is the figure the guard enforces', async ({
    ownerApi,
  }) => {
    const unitPrice = 100;
    const product = await ownerApi.createProduct({ quantityOnHand: 500, unitPrice });
    const unit = await ownerApi.cartTotal([{ productId: product.id, quantity: 1 }]);
    const UNITS = 50;
    const customer = await ownerApi.createCustomer({
      creditAllowed: true,
      creditLimit: unit * UNITS,
    });

    expect(Number((await credit(ownerApi, customer.id)).available)).toBeCloseTo(unit * UNITS, 2);

    const tooBig = await ownerApi.postRaw('/sales/complete', {
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      customerId: customer.id,
      items: [{ productId: product.id, quantity: UNITS + 1 }],
      payments: [],
      paymentDueDate: DUE,
    });
    expect(tooBig.status()).toBe(400);
    expect(await tooBig.text()).toContain('Credit limit exceeded');

    // Exactly the headroom completes — the server tests strictly greater-than.
    const exact = await ownerApi.post('/sales/complete', {
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      customerId: customer.id,
      items: [{ productId: product.id, quantity: UNITS }],
      payments: [],
      paymentDueDate: DUE,
    });
    expect(exact.status).toBe('COMPLETED');
    expect(Number((await credit(ownerApi, customer.id)).available)).toBe(0);
  });

  test('CUST-025 a customer barred from credit reports it before any sale', async ({ ownerApi }) => {
    const customer = await ownerApi.createCustomer({ creditAllowed: false, creditLimit: 10_000 });
    expect((await credit(ownerApi, customer.id)).creditAllowed).toBe(false);
  });

  test('CUST-029 the credit history lists account payments, newest first', async ({ ownerApi }) => {
    const { customerId, total } = await creditSale(ownerApi);
    await payAccount(ownerApi, customerId, Math.round((total / 3) * 100) / 100);
    const rows = await ownerApi.get(`/payments?customerId=${customerId}`);
    expect(rows).toHaveLength(1);
    // Not yet consumed — it is working against a balance that is still open.
    expect(rows[0].settledAt).toBeNull();

    await payAccount(ownerApi, customerId, await accountOwed(ownerApi, customerId));
    const after = await ownerApi.get(`/payments?customerId=${customerId}`);
    expect(after).toHaveLength(2);
    // Both are retired by the settlement that closed the balance.
    expect(after.every((r: any) => r.settledAt !== null)).toBe(true);
  });

  test('CUST-030 listing payments without a filter is refused', async ({ ownerApi }) => {
    const res = await ownerApi.getRaw('/payments');
    expect(res.status()).toBe(400);
  });

  // ── Dashboard ──────────────────────────────────────────────────────────────

  test('DASH-021 the receivable stat counts every unsettled balance', async ({ ownerApi }) => {
    const before = await ownerApi.get('/dashboard/stats');
    const { total } = await creditSale(ownerApi);
    const after = await ownerApi.get('/dashboard/stats');
    expect(Number(after.outstandingReceivable) - Number(before.outstandingReceivable)).toBeCloseTo(
      total,
      2,
    );
  });

  test('DASH-022 an account payment comes off the receivable at once', async ({ ownerApi }) => {
    const { customerId, total } = await creditSale(ownerApi);
    const owing = await ownerApi.get('/dashboard/stats');
    const half = Math.round((total / 2) * 100) / 100;
    await payAccount(ownerApi, customerId, half);
    const partly = await ownerApi.get('/dashboard/stats');
    // Money in hand reduces the receivable even though no invoice is settled yet.
    expect(
      Number(owing.outstandingReceivable) - Number(partly.outstandingReceivable),
    ).toBeCloseTo(half, 2);

    await payAccount(ownerApi, customerId, await accountOwed(ownerApi, customerId));
    const settled = await ownerApi.get('/dashboard/stats');
    expect(Number(owing.outstandingReceivable) - Number(settled.outstandingReceivable)).toBeCloseTo(
      total,
      2,
    );
  });

  /** What the customer's account currently owes. */
  async function accountOwed(api: Api, customerId: string): Promise<number> {
    return Number((await api.get(`/customers/${customerId}/credit`)).outstanding);
  }
});
