import { test, expect } from '../src/fixtures';

/**
 * A fixed line discount can be taken off each unit or off the line as a whole.
 * These run against the API because the server recomputes every discount from
 * the raw inputs — what the cashier was shown is irrelevant to what is charged.
 */
test.describe('DISC — per-unit vs whole-line fixed discounts', () => {
  const sale = (items: unknown[]) => ({
    branchId: 'brn_dev',
    registerId: 'reg_dev',
    items,
    payments: [{ method: 'CASH', amount: 10_000_000 }],
  });

  test('DISC-010 a whole-line fixed discount comes off once', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 100, unitPrice: 1000 });
    const res = await ownerApi.post(
      '/sales/complete',
      sale([{ productId: p.id, quantity: 3, discountType: 'FIXED', discountValue: 100 }]),
    );
    const detail = await ownerApi.get(`/sales/${res.id}`);
    expect(Number(detail.items[0].discountAmount)).toBe(100);
    expect(Number(detail.items[0].lineTotal)).toBe(2900);
  });

  test('DISC-011 a per-unit fixed discount comes off every unit', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 100, unitPrice: 1000 });
    const res = await ownerApi.post(
      '/sales/complete',
      sale([
        {
          productId: p.id,
          quantity: 3,
          discountType: 'FIXED',
          discountValue: 100,
          discountBasis: 'UNIT',
        },
      ]),
    );
    const detail = await ownerApi.get(`/sales/${res.id}`);
    expect(Number(detail.items[0].discountAmount)).toBe(300);
    expect(Number(detail.items[0].lineTotal)).toBe(2700);
    // Stored, so the bill can justify the figure.
    expect(detail.items[0].discountBasis).toBe('UNIT');
  });

  test('DISC-012 an omitted basis stays whole-line', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 100, unitPrice: 1000 });
    const res = await ownerApi.post(
      '/sales/complete',
      sale([{ productId: p.id, quantity: 4, discountType: 'FIXED', discountValue: 250 }]),
    );
    const detail = await ownerApi.get(`/sales/${res.id}`);
    expect(Number(detail.items[0].discountAmount)).toBe(250);
    expect(detail.items[0].discountBasis).toBe('LINE');
  });

  test('DISC-013 a per-unit percentage is refused', async ({ ownerApi }) => {
    // A percentage is already the same per unit and per line, so the flag would
    // silently mean nothing.
    const p = await ownerApi.createProduct({ quantityOnHand: 100, unitPrice: 1000 });
    const res = await ownerApi.postRaw(
      '/sales/complete',
      sale([
        {
          productId: p.id,
          quantity: 3,
          discountType: 'PERCENTAGE',
          discountValue: 10,
          discountBasis: 'UNIT',
        },
      ]),
    );
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('fixed amount');
  });

  test('DISC-014 a per-unit discount cannot drive a line negative', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 100, unitPrice: 1000 });
    const res = await ownerApi.post(
      '/sales/complete',
      sale([
        {
          productId: p.id,
          quantity: 2,
          discountType: 'FIXED',
          discountValue: 5000,
          discountBasis: 'UNIT',
        },
      ]),
    );
    const detail = await ownerApi.get(`/sales/${res.id}`);
    expect(Number(detail.items[0].lineTotal)).toBe(0);
    expect(Number(detail.total)).toBe(0);
  });

  test('DISC-017 a quotation honours a per-unit line discount', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 100, unitPrice: 1000 });
    const cust = await ownerApi.createCustomer({});
    const q = await ownerApi.post('/quotations', {
      customerId: cust.id,
      branchId: 'brn_dev',
      items: [
        {
          productId: p.id,
          quantity: 3,
          discountType: 'FIXED',
          discountValue: 100,
          discountBasis: 'UNIT',
        },
      ],
    });
    const detail = await ownerApi.get(`/quotations/${q.id}`);
    const item = detail.items[0];
    expect(Number(item.discountAmount)).toBe(300);
    expect(Number(item.lineTotal)).toBe(2700);
    expect(item.discountBasis).toBe('UNIT');
  });

  test('DISC-018 converting a quotation charges what was quoted', async ({ ownerApi }) => {
    // The hand-map into the sale has no compiler backstop: drop the basis and
    // the customer is invoiced the whole-line amount instead.
    const p = await ownerApi.createProduct({ quantityOnHand: 100, unitPrice: 500 });
    const cust = await ownerApi.createCustomer({});
    const q = await ownerApi.post('/quotations', {
      customerId: cust.id,
      branchId: 'brn_dev',
      items: [
        {
          productId: p.id,
          quantity: 20,
          discountType: 'FIXED',
          discountValue: 100,
          discountBasis: 'UNIT',
        },
      ],
    });
    const quoted = Number((await ownerApi.get(`/quotations/${q.id}`)).grandTotal);

    const sale = await ownerApi.post(`/quotations/${q.id}/convert-to-sale`, {
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      payments: [{ method: 'CASH', amount: 10_000_000 }],
    });
    const detail = await ownerApi.get(`/sales/${sale.saleId}`);
    expect(Number(detail.total)).toBe(quoted);
    expect(Number(detail.items[0].discountAmount)).toBe(2000);
    expect(detail.items[0].discountBasis).toBe('UNIT');
  });

  test('DISC-019 a per-unit percentage is refused on a quotation', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 100, unitPrice: 1000 });
    const cust = await ownerApi.createCustomer({});
    const res = await ownerApi.postRaw('/quotations', {
      customerId: cust.id,
      branchId: 'brn_dev',
      items: [
        {
          productId: p.id,
          quantity: 3,
          discountType: 'PERCENTAGE',
          discountValue: 10,
          discountBasis: 'UNIT',
        },
      ],
    });
    expect(res.status()).toBe(400);
  });

  test('DISC-015 the whole-cart discount is unaffected by a line basis', async ({ ownerApi }) => {
    // computeDiscount is shared with the order discount, which has no units.
    const p = await ownerApi.createProduct({ quantityOnHand: 100, unitPrice: 1000 });
    const res = await ownerApi.post('/sales/complete', {
      ...sale([
        {
          productId: p.id,
          quantity: 3,
          discountType: 'FIXED',
          discountValue: 100,
          discountBasis: 'UNIT',
        },
      ]),
      orderDiscountType: 'FIXED',
      orderDiscountValue: 200,
    });
    const detail = await ownerApi.get(`/sales/${res.id}`);
    expect(Number(detail.items[0].discountAmount)).toBe(300);
    // 200 off the cart, once — not 600.
    expect(Number(detail.orderDiscountAmount)).toBe(200);
    expect(Number(detail.total)).toBe(2500);
  });
});
