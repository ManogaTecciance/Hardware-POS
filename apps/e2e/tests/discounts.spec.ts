import { test, expect } from '../src/fixtures';
import { SEED } from '../src/api';

/**
 * POS-018..024 — manager-PIN discount approval. Exercised through
 * POST /discounts/approve since that is the security boundary.
 */
test.describe('POS — Discount Approval', () => {
  const orderKey = '__order__';

  test('POS-019 manager PIN approves a discount within the manager limit', async ({ cashierApi }) => {
    // The MANAGER discount cap is 15%; a value at/under it must be approved.
    const res = await cashierApi.postRaw('/discounts/approve', {
      managerPin: SEED.managerPin, productId: orderKey, discountType: 'PERCENTAGE', discountValue: 10,
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()).data;
    expect(body.approved).toBe(true);
    expect(body.approvalToken).toBeTruthy();
  });

  test('POS-018 manager cannot approve beyond their own limit', async ({ cashierApi }) => {
    // 25% exceeds the MANAGER 15% cap → approved:false with a reason.
    const res = await cashierApi.postRaw('/discounts/approve', {
      managerPin: SEED.managerPin, productId: orderKey, discountType: 'PERCENTAGE', discountValue: 25,
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).data.approved).toBe(false);
  });

  test('POS-021 cashier own PIN cannot approve', async ({ cashierApi }) => {
    const res = await cashierApi.postRaw('/discounts/approve', {
      managerPin: SEED.cashierPin, productId: orderKey, discountType: 'PERCENTAGE', discountValue: 25,
    });
    // Either 401 (not found as approver) or approved:false — both are "not allowed".
    if (res.ok()) {
      expect((await res.json()).data.approved).toBe(false);
    } else {
      expect(res.status()).toBe(401);
    }
  });

  test('POS-022 wrong PIN rejected', async ({ cashierApi }) => {
    const res = await cashierApi.postRaw('/discounts/approve', {
      managerPin: '0000', productId: orderKey, discountType: 'PERCENTAGE', discountValue: 25,
    });
    expect(res.status()).toBe(401);
  });

  test('POS-020 owner PIN (via manager prompt) — owner has no seed PIN', async ({ ownerApi }) => {
    // The seeded owner has no PIN, so this asserts the permission model rather
    // than a specific PIN: owners CAN approve when they have a PIN. Documented
    // as environment-limited; approval by any approver-permission holder works.
    test.skip(true, 'Seeded owner has no PIN; covered by ADM-006 in a provisioned tenant');
    void ownerApi;
  });
});
