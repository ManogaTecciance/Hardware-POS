import { test, expect } from '../src/fixtures';

test.describe('RET — Returns & Refunds', () => {
  test('RET-001 returnable items listed for a sale', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 20, unitPrice: 500 });
    const sale = await ownerApi.completeSale([{ productId: p.id, quantity: 3 }]);
    const items = await ownerApi.get(`/sales/${sale.id}/returnable-items`);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].saleItemId).toBeTruthy();
  });

  test('RET-004 full return completes and restocks (with manager approval)', async ({ ownerApi, managerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 20, unitPrice: 500 });
    const sale = await ownerApi.completeSale([{ productId: p.id, quantity: 2 }]);
    const afterSale = await ownerApi.get(`/products/${p.id}`);
    const items = await ownerApi.get(`/sales/${sale.id}/returnable-items`);
    const lines = items.map((it: any) => ({
      saleItemId: it.saleItemId,
      returnQuantity: Number(it.availableReturnQuantity),
      returnReason: 'CHANGED_MIND' as const,
      itemCondition: 'GOOD' as const,
      stockDisposition: 'RETURN_TO_STOCK' as const,
    }));

    // A full-sale return requires manager approval — preview → approve → create.
    const preview = await ownerApi.post('/returns/preview', { originalSaleId: sale.id, items: lines, refundMethod: 'CASH' });
    const approval = await managerApi.post('/returns/approve', {
      managerPin: '2222', originalSaleId: sale.id, refundTotal: preview.refundTotal,
    });
    expect(approval.approvalToken).toBeTruthy();

    const ret = await ownerApi.post('/returns', {
      originalSaleId: sale.id,
      refundMethod: 'CASH',
      approvalToken: approval.approvalToken,
      items: lines,
    });
    expect(['COMPLETED', 'APPROVED']).toContain(ret.status);

    // RET-007: a GOOD + RETURN_TO_STOCK return restores local stock EAGERLY —
    // the instant the return completes, symmetric with a sale's decrement and
    // independent of the (async) QuickBooks push.
    const afterReturn = await ownerApi.get(`/products/${p.id}`);
    expect(Number(afterReturn.quantityOnHand)).toBe(Number(afterSale.quantityOnHand) + 2);
  });

  test('RET-008 damaged disposition does NOT restock', async ({ ownerApi, managerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 20, unitPrice: 500 });
    const sale = await ownerApi.completeSale([{ productId: p.id, quantity: 2 }]);
    const afterSale = await ownerApi.get(`/products/${p.id}`);
    const items = await ownerApi.get(`/sales/${sale.id}/returnable-items`);
    // A damaged-item return requires manager approval (regardless of quantity).
    const lines = [{
      saleItemId: items[0].saleItemId,
      returnQuantity: 1,
      returnReason: 'DAMAGED' as const,
      itemCondition: 'DAMAGED' as const,
      stockDisposition: 'DAMAGED_STOCK' as const,
    }];
    const preview = await ownerApi.post('/returns/preview', { originalSaleId: sale.id, items: lines, refundMethod: 'CASH' });
    const approval = await managerApi.post('/returns/approve', {
      managerPin: '2222', originalSaleId: sale.id, refundTotal: preview.refundTotal,
    });
    const ret = await ownerApi.post('/returns', {
      originalSaleId: sale.id, refundMethod: 'CASH', approvalToken: approval.approvalToken, items: lines,
    });
    expect(['COMPLETED', 'APPROVED']).toContain(ret.status);
    // DAMAGED_STOCK must never re-enter available inventory.
    const afterReturn = await ownerApi.get(`/products/${p.id}`);
    expect(Number(afterReturn.quantityOnHand)).toBe(Number(afterSale.quantityOnHand));
  });

  test('RET-003 cannot return more than purchased', async ({ ownerApi }) => {
    const p = await ownerApi.createProduct({ quantityOnHand: 20, unitPrice: 500 });
    const sale = await ownerApi.completeSale([{ productId: p.id, quantity: 1 }]);
    const items = await ownerApi.get(`/sales/${sale.id}/returnable-items`);
    const res = await ownerApi.postRaw('/returns', {
      originalSaleId: sale.id,
      refundMethod: 'CASH',
      items: [{
        saleItemId: items[0].saleItemId,
        returnQuantity: 99,
        returnReason: 'CHANGED_MIND',
        itemCondition: 'GOOD',
        stockDisposition: 'RETURN_TO_STOCK',
      }],
    });
    expect(res.status()).toBe(400);
  });

  test('RET-016 returns list is reachable', async ({ ownerApi }) => {
    const res = await ownerApi.getRaw('/returns?page=1&pageSize=5');
    expect(res.ok()).toBeTruthy();
  });
});
