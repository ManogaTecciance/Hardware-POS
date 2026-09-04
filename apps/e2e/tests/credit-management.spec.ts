import { test, expect } from '../src/fixtures';
import { Api } from '../src/api';

/**
 * Credit management: available credit, receivables, payment due dates, and
 * recording payments received.
 *
 * Driven through the API because these are arithmetic and guard rules — a rule
 * that only holds in the browser is not a rule.
 */
test.describe('CREDIT — limits, due dates & settlement', () => {
  const DUE = Api.daysAhead(30);

  /** A credit customer with a fresh unpaid sale; returns both plus the total. */
  async function creditSale(
    api: Api,
    opts: {
      creditLimit?: number | null;
      quantity?: number;
      paymentDueDate?: string;
      saleDate?: string;
    } = {},
  ) {
    const product = await api.createProduct({ quantityOnHand: 100, unitPrice: 10_000 });
    const quantity = opts.quantity ?? 1;
    const total = await api.cartTotal([{ productId: product.id, quantity }]);
    const customer = await api.createCustomer({
      creditAllowed: true,
      creditLimit: opts.creditLimit === undefined ? total * 10 : opts.creditLimit,
    });
    const sale = await api.post('/sales/complete', {
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      customerId: customer.id,
      items: [{ productId: product.id, quantity }],
      payments: [],
      ...(opts.saleDate ? { saleDate: opts.saleDate } : {}),
      paymentDueDate: opts.paymentDueDate ?? DUE,
    });
    return { product, customer, sale, total };
  }

  /**
   * The customer's row as the customers LIST renders it — the credit figures
   * live there, not on the detail endpoint. Factory names carry the run id, so
   * a search by name resolves to exactly this customer.
   */
  async function customerRow(api: Api, customer: { id: string; name: string }) {
    const page = await api.get(
      `/customers?page=1&pageSize=100&search=${encodeURIComponent(customer.name)}`,
    );
    const row = page.items.find((c: any) => c.id === customer.id);
    expect(row, `customer ${customer.name} missing from the list`).toBeTruthy();
    return row;
  }

  // ── REQ005 — payment due date ──────────────────────────────────────────────

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
    const detail = await ownerApi.get(`/sales/${sale.id}`);
    expect(detail.paymentDueDate).not.toBeNull();
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

  test('SALE-021 the overdue filter returns only sales past due and still owing', async ({
    ownerApi,
  }) => {
    // Backdated, so a due date in the past is not also before the invoice date.
    const overdue = await creditSale(ownerApi, {
      saleDate: Api.daysAgo(5),
      paymentDueDate: Api.daysAgo(1),
    });
    const notYetDue = await creditSale(ownerApi);

    const page = await ownerApi.get('/sales?page=1&pageSize=200&overdue=true');
    const ids = page.items.map((s: any) => s.id);
    expect(ids).toContain(overdue.sale.id);
    expect(ids).not.toContain(notYetDue.sale.id);
    for (const s of page.items) {
      expect(Number(s.balanceAmount)).toBeGreaterThan(0);
    }
  });

  test('SALE-022 settling an overdue sale drops it from the overdue filter', async ({
    ownerApi,
  }) => {
    const { sale, total } = await creditSale(ownerApi, {
      saleDate: Api.daysAgo(5),
      paymentDueDate: Api.daysAgo(1),
    });
    await ownerApi.post('/payments', { saleId: sale.id, method: 'CASH', amount: total });
    const page = await ownerApi.get('/sales?page=1&pageSize=200&overdue=true');
    expect(page.items.map((s: any) => s.id)).not.toContain(sale.id);
  });

  // ── REQ006 — recording payments received ───────────────────────────────────

  test('PAY-019 recording a payment reduces the balance and settles at zero', async ({
    ownerApi,
  }) => {
    const { sale, total } = await creditSale(ownerApi);
    const half = Math.round((total / 2) * 100) / 100;

    await ownerApi.post('/payments', { saleId: sale.id, method: 'CASH', amount: half });
    let detail = await ownerApi.get(`/sales/${sale.id}`);
    expect(detail.paymentStatus).toBe('PARTIAL');
    expect(Number(detail.balanceAmount)).toBeCloseTo(total - half, 2);

    await ownerApi.post('/payments', {
      saleId: sale.id,
      method: 'CARD',
      amount: Math.round((total - half) * 100) / 100,
    });
    detail = await ownerApi.get(`/sales/${sale.id}`);
    expect(detail.paymentStatus).toBe('PAID');
    expect(Number(detail.balanceAmount)).toBe(0);
  });

  test('PAY-027 each instalment is kept as its own payment record', async ({ ownerApi }) => {
    const { sale, total } = await creditSale(ownerApi);
    const third = Math.floor((total / 3) * 100) / 100;
    await ownerApi.post('/payments', { saleId: sale.id, method: 'CASH', amount: third });
    await ownerApi.post('/payments', {
      saleId: sale.id,
      method: 'CARD',
      amount: third,
      reference: 'AUTH-2201',
    });

    const detail = await ownerApi.get(`/sales/${sale.id}`);
    expect(detail.payments).toHaveLength(2);
    // Each carries its own timestamp, so the list can show when money came in.
    for (const p of detail.payments) {
      expect(p.createdAt).toBeTruthy();
    }
    expect(detail.payments.map((p: any) => p.method)).toEqual(['CASH', 'CARD']);
    expect(detail.payments[1].reference).toBe('AUTH-2201');
  });

  test('PAY-021 a payment larger than the balance is rejected', async ({ ownerApi }) => {
    const { sale, total } = await creditSale(ownerApi);
    const res = await ownerApi.postRaw('/payments', {
      saleId: sale.id,
      method: 'CASH',
      amount: total + 1,
    });
    expect(res.status()).toBe(400);
    const detail = await ownerApi.get(`/sales/${sale.id}`);
    expect(Number(detail.balanceAmount)).toBeCloseTo(total, 2);
  });

  test('PAY-022 a payment against a settled sale is rejected', async ({ ownerApi }) => {
    const { sale, total } = await creditSale(ownerApi);
    await ownerApi.post('/payments', { saleId: sale.id, method: 'CASH', amount: total });
    const res = await ownerApi.postRaw('/payments', {
      saleId: sale.id,
      method: 'CASH',
      amount: 1,
    });
    expect(res.status()).toBe(400);
  });

  test('SALE-023 the sales list reports when the last payment came in', async ({ ownerApi }) => {
    const { sale, total } = await creditSale(ownerApi);
    await ownerApi.post('/payments', {
      saleId: sale.id,
      method: 'CASH',
      amount: Math.round((total / 2) * 100) / 100,
    });
    const page = await ownerApi.get(`/sales?page=1&pageSize=50&search=${sale.saleNumber}`);
    const row = page.items.find((s: any) => s.id === sale.id);
    expect(row).toBeTruthy();
    expect(row.lastPaymentAt).toBeTruthy();
    expect(String(row.paymentDueDate).slice(0, 10)).toBe(DUE);
  });

  test('SALE-028 the Credit / Unpaid filter includes part-paid sales', async ({ ownerApi }) => {
    // The app shows a part-paid sale as "Credit / Unpaid", so the filter behind
    // that label must return it — otherwise the list hides sales it says exist.
    const partPaid = await creditSale(ownerApi);
    await ownerApi.post('/payments', {
      saleId: partPaid.sale.id,
      method: 'CASH',
      amount: Math.round((partPaid.total / 2) * 100) / 100,
    });
    const wholly = await creditSale(ownerApi);
    const settled = await creditSale(ownerApi);
    await ownerApi.post('/payments', {
      saleId: settled.sale.id,
      method: 'CASH',
      amount: settled.total,
    });

    const page = await ownerApi.get('/sales?page=1&pageSize=200&paymentStatus=UNPAID');
    const ids = page.items.map((s: any) => s.id);
    expect(ids).toContain(partPaid.sale.id);
    expect(ids).toContain(wholly.sale.id);
    expect(ids).not.toContain(settled.sale.id);
  });

  test('SALE-029 filtering by PARTIAL alone still narrows to part-paid sales', async ({
    ownerApi,
  }) => {
    const partPaid = await creditSale(ownerApi);
    await ownerApi.post('/payments', {
      saleId: partPaid.sale.id,
      method: 'CASH',
      amount: Math.round((partPaid.total / 2) * 100) / 100,
    });
    const wholly = await creditSale(ownerApi);

    const page = await ownerApi.get('/sales?page=1&pageSize=200&paymentStatus=PARTIAL');
    const ids = page.items.map((s: any) => s.id);
    expect(ids).toContain(partPaid.sale.id);
    expect(ids).not.toContain(wholly.sale.id);
  });

  // ── REQ003 / REQ004 — available credit and total receivable ────────────────

  test('CUST-017 available credit is the limit minus what is owed', async ({ ownerApi }) => {
    const { customer, total } = await creditSale(ownerApi, { creditLimit: 100_000 });
    const row = await customerRow(ownerApi, customer);
    expect(Number(row.outstandingCredit)).toBeCloseTo(total, 2);
    expect(Number(row.availableCredit)).toBeCloseTo(100_000 - total, 2);
  });

  test('CUST-018 a customer with no limit reports no available credit', async ({ ownerApi }) => {
    const { customer } = await creditSale(ownerApi, { creditLimit: null });
    const row = await customerRow(ownerApi, customer);
    // Null, not zero — "no limit set" must not read as "nothing left".
    expect(row.availableCredit).toBeNull();
  });

  test('CUST-019 settling a sale releases the credit again', async ({ ownerApi }) => {
    const { customer, sale, total } = await creditSale(ownerApi, { creditLimit: 100_000 });
    await ownerApi.post('/payments', { saleId: sale.id, method: 'CASH', amount: total });
    const row = await customerRow(ownerApi, customer);
    expect(Number(row.outstandingCredit)).toBe(0);
    expect(Number(row.availableCredit)).toBeCloseTo(100_000, 2);
  });

  test('CUST-020 the customers list filters to those with credit outstanding', async ({
    ownerApi,
  }) => {
    const owing = await creditSale(ownerApi);
    const settled = await creditSale(ownerApi);
    await ownerApi.post('/payments', {
      saleId: settled.sale.id,
      method: 'CASH',
      amount: settled.total,
    });

    const page = await ownerApi.get(
      '/customers?page=1&pageSize=200&hasOutstandingCredit=true&isActive=true',
    );
    const ids = page.items.map((c: any) => c.id);
    expect(ids).toContain(owing.customer.id);
    expect(ids).not.toContain(settled.customer.id);
  });

  test('CUST-022 the credit endpoint reports the position the till shows', async ({ ownerApi }) => {
    const { customer, total } = await creditSale(ownerApi, { creditLimit: 100_000 });
    const credit = await ownerApi.get(`/customers/${customer.id}/credit`);
    expect(credit.creditAllowed).toBe(true);
    expect(Number(credit.creditLimit)).toBe(100_000);
    expect(Number(credit.outstanding)).toBeCloseTo(total, 2);
    expect(Number(credit.available)).toBeCloseTo(100_000 - total, 2);
  });

  test('CUST-023 no limit reports null available, not zero', async ({ ownerApi }) => {
    const { customer } = await creditSale(ownerApi, { creditLimit: null });
    const credit = await ownerApi.get(`/customers/${customer.id}/credit`);
    expect(credit.creditLimit).toBeNull();
    expect(credit.available).toBeNull();
  });

  test('CUST-024 the figure the till shows is the figure the guard enforces', async ({
    ownerApi,
  }) => {
    // The whole point of the live warning: what the cashier is told is available
    // must be exactly what completes. A sale for that amount goes through, and a
    // cent more does not.
    const product = await ownerApi.createProduct({ quantityOnHand: 500, unitPrice: 100 });
    // A limit that is a whole number of units, so "exactly the headroom" is a
    // quantity and not a rounding argument — tax, if any, is already in `unit`.
    const unit = await ownerApi.cartTotal([{ productId: product.id, quantity: 1 }]);
    const UNITS = 50;
    const customer = await ownerApi.createCustomer({
      creditAllowed: true,
      creditLimit: unit * UNITS,
    });

    const before = await ownerApi.get(`/customers/${customer.id}/credit`);
    expect(Number(before.available)).toBeCloseTo(unit * UNITS, 2);

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

    // Exactly the available headroom completes — the server tests strictly
    // greater-than, and the till's warning must not be stricter than that.
    const exact = await ownerApi.post('/sales/complete', {
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      customerId: customer.id,
      items: [{ productId: product.id, quantity: UNITS }],
      payments: [],
      paymentDueDate: DUE,
    });
    expect(exact.status).toBe('COMPLETED');

    const after = await ownerApi.get(`/customers/${customer.id}/credit`);
    expect(Number(after.available)).toBe(0);
  });

  test('CUST-025 a customer barred from credit reports it before any sale', async ({ ownerApi }) => {
    const customer = await ownerApi.createCustomer({ creditAllowed: false, creditLimit: 10_000 });
    const credit = await ownerApi.get(`/customers/${customer.id}/credit`);
    // The till reads this and says so, rather than letting the cashier find out
    // when Complete Payment is pressed.
    expect(credit.creditAllowed).toBe(false);
  });

  test('DASH-021 the receivable stat counts every unsettled balance', async ({ ownerApi }) => {
    const before = await ownerApi.get('/dashboard/stats');
    const { total } = await creditSale(ownerApi);
    const after = await ownerApi.get('/dashboard/stats');
    expect(Number(after.outstandingReceivable) - Number(before.outstandingReceivable)).toBeCloseTo(
      total,
      2,
    );
  });

  test('DASH-022 settling a sale removes it from the receivable stat', async ({ ownerApi }) => {
    const { sale, total } = await creditSale(ownerApi);
    const owing = await ownerApi.get('/dashboard/stats');
    await ownerApi.post('/payments', { saleId: sale.id, method: 'CASH', amount: total });
    const settled = await ownerApi.get('/dashboard/stats');
    expect(Number(owing.outstandingReceivable) - Number(settled.outstandingReceivable)).toBeCloseTo(
      total,
      2,
    );
  });
});
