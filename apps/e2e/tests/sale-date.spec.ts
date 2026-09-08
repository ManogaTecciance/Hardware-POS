import { test, expect } from '../src/fixtures';
import { Api } from '../src/api';

/**
 * SALE-012..017 — backdating a POS invoice. The cart's date selector sends
 * `saleDate`; these assert what the API does with it, since that is the security
 * and accounting boundary.
 */
test.describe('SALE — Invoice date (backdating)', () => {
  test('SALE-012 a sale completed with no date is dated now', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 500 });
    const sale = await ownerApi.completeSale([{ productId: p.id, quantity: 1 }]);
    const detail = await ownerApi.get(`/sales/${sale.id}`);
    const completed = new Date(detail.completedAt);
    expect(Math.abs(Date.now() - completed.getTime())).toBeLessThan(5 * 60 * 1000);
  });

  test('SALE-013 a past date is stored as the sale date', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 500 });
    const picked = Api.daysAgo(10);
    const sale = await ownerApi.completeSale([{ productId: p.id, quantity: 1 }], {
      saleDate: picked,
    });
    const detail = await ownerApi.get(`/sales/${sale.id}`);
    // Compare calendar days; the stored value carries a time of day.
    const stored = new Date(detail.completedAt);
    const ymd = `${stored.getFullYear()}-${String(stored.getMonth() + 1).padStart(2, '0')}-${String(
      stored.getDate(),
    ).padStart(2, '0')}`;
    expect(ymd).toBe(picked);
  });

  test('SALE-014 a future date is rejected', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 500 });
    const res = await ownerApi.postRaw('/sales/complete', {
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      saleDate: Api.daysAgo(-1), // tomorrow
      items: [{ productId: p.id, quantity: 1 }],
      payments: [{ method: 'CASH', amount: 10_000_000 }],
    });
    expect(res.status()).toBe(400);
  });

  test('SALE-015 a rejected future date creates no sale and moves no stock', async ({
    ownerApi,
  }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 500 });
    await ownerApi.postRaw('/sales/complete', {
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      saleDate: Api.daysAgo(-30),
      items: [{ productId: p.id, quantity: 3 }],
      payments: [{ method: 'CASH', amount: 10_000_000 }],
    });
    const after = await ownerApi.get(`/products/${p.id}`);
    expect(Number(after.quantityOnHand)).toBe(10);
  });

  test('SALE-016 stock still moves today for a backdated sale', async ({ ownerApi }) => {
    // Decided scope: the invoice date is an accounting date, not a stock date.
    const p = await ownerApi.createProduct({ quantityOnHand: 20, unitPrice: 500 });
    await ownerApi.completeSale([{ productId: p.id, quantity: 2 }], {
      saleDate: Api.daysAgo(45),
    });
    const after = await ownerApi.get(`/products/${p.id}`);
    expect(Number(after.quantityOnHand)).toBe(18);
  });

  test('SALE-017 a backdated sale is listed under its invoice date', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 10, unitPrice: 500 });
    const picked = Api.daysAgo(20);
    const sale = await ownerApi.completeSale([{ productId: p.id, quantity: 1 }], {
      saleDate: picked,
    });

    // Bounds are built as local instants, the way the web date filter does it
    // (components/sales/date-range-filter.tsx) — hard-coded `Z` bounds would only
    // line up when the API happens to run in UTC.
    const dayRange = (ymd: string) => {
      const from = new Date(`${ymd}T00:00:00`);
      const to = new Date(`${ymd}T23:59:59.999`);
      return `dateFrom=${from.toISOString()}&dateTo=${to.toISOString()}`;
    };

    // Found when the range covers the picked day...
    const inRange = await ownerApi.get(`/sales?page=1&pageSize=100&${dayRange(picked)}`);
    expect(inRange.items.some((s: { id: string }) => s.id === sale.id)).toBe(true);

    // ...and absent from today, where it was actually keyed in.
    const todayRange = await ownerApi.get(`/sales?page=1&pageSize=100&${dayRange(Api.daysAgo(0))}`);
    expect(todayRange.items.some((s: { id: string }) => s.id === sale.id)).toBe(false);
  });
});
