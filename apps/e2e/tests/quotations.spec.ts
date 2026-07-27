import { test, expect } from '../src/fixtures';

test.describe('QUO — Quotations', () => {
  test('QUO-001 build a draft quotation with server totals', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ unitPrice: 2000 });
    const q = await ownerApi.post('/quotations', {
      items: [{ productId: p.id, quantity: 3 }],
      status: 'DRAFT',
    });
    expect(q.id).toBeTruthy();
    expect(Number(q.grandTotal)).toBeGreaterThan(0);
  });

  test('QUO-003 line total reflects qty × price − discount', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ unitPrice: 1000 });
    const preview = await ownerApi.post('/quotations/preview', {
      items: [{ productId: p.id, quantity: 3, discountType: 'PERCENTAGE', discountValue: 10 }],
    });
    // 3×1000 = 3000 − 10% = 2700 (before any tax handling in preview)
    expect(preview.items[0].lineTotal).toBeCloseTo(2700, 0);
  });

  test('QUO-004 quantity not capped by stock', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 2, unitPrice: 500 });
    const q = await ownerApi.post('/quotations', {
      items: [{ productId: p.id, quantity: 50 }],
      status: 'DRAFT',
    });
    expect(q.id).toBeTruthy();
  });

  test('QUO-012 convert accepted quotation to sale', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 50, unitPrice: 800 });
    const q = await ownerApi.post('/quotations', {
      items: [{ productId: p.id, quantity: 2 }], status: 'DRAFT',
    });
    await ownerApi.post(`/quotations/${q.id}/mark-sent`);
    const sale = await ownerApi.post(`/quotations/${q.id}/convert-to-sale`, {
      branchId: 'brn_dev', registerId: 'reg_dev',
      payments: [{ method: 'CASH', amount: 10_000_000 }],
    });
    expect(sale.saleNumber ?? sale.id).toBeTruthy();
    const after = await ownerApi.get(`/quotations/${q.id}`);
    expect(after.status).toBe('CONVERTED_TO_SALE');
  });

  test('QUO-014 duplicate quotation creates a new draft', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ unitPrice: 500 });
    const q = await ownerApi.post('/quotations', { items: [{ productId: p.id, quantity: 1 }], status: 'DRAFT' });
    const dup = await ownerApi.post(`/quotations/${q.id}/duplicate`);
    expect(dup.id).not.toBe(q.id);
    expect(dup.status).toBe('DRAFT');
  });

  test('QUO-018 quotation numbers are distinct', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ unitPrice: 100 });
    const a = await ownerApi.post('/quotations', { items: [{ productId: p.id, quantity: 1 }], status: 'DRAFT' });
    const b = await ownerApi.post('/quotations', { items: [{ productId: p.id, quantity: 1 }], status: 'DRAFT' });
    expect(a.quotationNumber ?? a.number).not.toBe(b.quotationNumber ?? b.number);
  });
});
