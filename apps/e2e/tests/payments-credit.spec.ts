import { test, expect } from '../src/fixtures';
import { uniq } from '../src/api';

test.describe('PAY — Payments, Credit & Stock', () => {
  test('PAY-013 stock decremented once on completion', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 20, unitPrice: 500 });
    await ownerApi.completeSale([{ productId: p.id, quantity: 2 }]);
    const after = await ownerApi.get(`/products/${p.id}`);
    expect(Number(after.quantityOnHand)).toBe(18);
  });

  test('PAY-007 credit blocked for non-credit customer', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 1000 });
    const cust = await ownerApi.createCustomer({ creditAllowed: false });
    const res = await ownerApi.postRaw('/sales/complete', {
      branchId: 'brn_dev', registerId: 'reg_dev', customerId: cust.id,
      items: [{ productId: p.id, quantity: 1 }],
      payments: [],
    });
    expect(res.status()).toBe(400);
  });

  test('PAY-006 credit sale allowed for credit customer', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 1000 });
    const cust = await ownerApi.createCustomer({ creditAllowed: true });
    const sale = await ownerApi.post('/sales/complete', {
      branchId: 'brn_dev', registerId: 'reg_dev', customerId: cust.id,
      items: [{ productId: p.id, quantity: 1 }],
      payments: [],
    });
    expect(sale.status).toBe('COMPLETED');
    expect(['UNPAID', 'PARTIAL']).toContain(sale.paymentStatus);
  });

  test('PAY-009 credit limit enforced', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 100, unitPrice: 10000 });
    const total = await ownerApi.cartTotal([{ productId: p.id, quantity: 5 }]); // 50k
    const cust = await ownerApi.createCustomer({ creditAllowed: true, creditLimit: total - 1 });
    const res = await ownerApi.postRaw('/sales/complete', {
      branchId: 'brn_dev', registerId: 'reg_dev', customerId: cust.id,
      items: [{ productId: p.id, quantity: 5 }],
      payments: [],
    });
    expect(res.status()).toBe(400);
  });

  test('PAY-010 credit exactly at limit allowed', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 100, unitPrice: 10000 });
    const total = await ownerApi.cartTotal([{ productId: p.id, quantity: 5 }]);
    const cust = await ownerApi.createCustomer({ creditAllowed: true, creditLimit: total });
    const sale = await ownerApi.post('/sales/complete', {
      branchId: 'brn_dev', registerId: 'reg_dev', customerId: cust.id,
      items: [{ productId: p.id, quantity: 5 }],
      payments: [],
    });
    expect(sale.status).toBe('COMPLETED');
  });

  test('PAY-011 null credit limit is unlimited', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 1000, unitPrice: 100000 });
    const cust = await ownerApi.createCustomer({ creditAllowed: true, creditLimit: null });
    const sale = await ownerApi.post('/sales/complete', {
      branchId: 'brn_dev', registerId: 'reg_dev', customerId: cust.id,
      items: [{ productId: p.id, quantity: 10 }],
      payments: [],
    });
    expect(sale.status).toBe('COMPLETED');
  });

  test('PAY-012 outstanding aggregates across credit sales', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 100, unitPrice: 10000 });
    const one = await ownerApi.cartTotal([{ productId: p.id, quantity: 1 }]);
    const cust = await ownerApi.createCustomer({ creditAllowed: true, creditLimit: one * 1.5 });
    await ownerApi.post('/sales/complete', {
      branchId: 'brn_dev', registerId: 'reg_dev', customerId: cust.id,
      items: [{ productId: p.id, quantity: 1 }], payments: [],
    });
    // Second credit sale would push total outstanding over 1.5×.
    const res = await ownerApi.postRaw('/sales/complete', {
      branchId: 'brn_dev', registerId: 'reg_dev', customerId: cust.id,
      items: [{ productId: p.id, quantity: 1 }], payments: [],
    });
    expect(res.status()).toBe(400);
  });

  test('PAY-014 oversell blocked at completion', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 3, unitPrice: 500 });
    const res = await ownerApi.postRaw('/sales/complete', {
      branchId: 'brn_dev', registerId: 'reg_dev',
      items: [{ productId: p.id, quantity: 999 }],
      payments: [{ method: 'CASH', amount: 10_000_000 }],
    });
    expect(res.status()).toBe(400);
    const after = await ownerApi.get(`/products/${p.id}`);
    expect(Number(after.quantityOnHand)).toBe(3); // unchanged
  });

  test('PAY-015 concurrent sales get distinct sale numbers', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 100, unitPrice: 100 });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        ownerApi.postRaw('/sales/complete', {
          branchId: 'brn_dev', registerId: 'reg_dev',
          items: [{ productId: p.id, quantity: 1 }],
          payments: [{ method: 'CASH', amount: 10_000_000 }],
        }),
      ),
    );
    const numbers: string[] = [];
    for (const r of results) {
      expect(r.ok()).toBeTruthy();
      numbers.push((await r.json()).data.saleNumber);
    }
    expect(new Set(numbers).size).toBe(6);
  });

  test('PAY-016 zero-total sale disallowed', async ({ ownerApi }) => {
    const res = await ownerApi.postRaw('/sales/complete', {
      branchId: 'brn_dev', registerId: 'reg_dev', items: [],
      payments: [],
    });
    expect(res.status()).toBe(400);
  });

  test('PAY-001 cash sale completes as paid', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 250 });
    const sale = await ownerApi.completeSale([{ productId: p.id, quantity: 2 }]);
    expect(sale.status).toBe('COMPLETED');
    expect(sale.paymentStatus).toBe('PAID');
  });

  test('PAY-003 split payment recorded', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 1000 });
    const total = await ownerApi.cartTotal([{ productId: p.id, quantity: 1 }]);
    const half = Math.round((total / 2) * 100) / 100;
    const sale = await ownerApi.post('/sales/complete', {
      branchId: 'brn_dev', registerId: 'reg_dev',
      items: [{ productId: p.id, quantity: 1 }],
      payments: [
        { method: 'CASH', amount: half },
        { method: 'CARD', amount: Math.round((total - half) * 100) / 100 },
      ],
    });
    expect(sale.paymentStatus).toBe('PAID');
  });
});
