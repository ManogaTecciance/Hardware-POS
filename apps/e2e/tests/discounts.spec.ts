import { test, expect } from '../src/fixtures';
import { SEED } from '../src/api';

/**
 * POS-018..024 — manager-PIN discount approval. Exercised through
 * POST /discounts/approve since that is the security boundary.
 */
test.describe('POS — Discount Approval', () => {
  const orderKey = '__order__';

  test('POS-019 approver PIN approves a discount within the manager limit', async ({ cashierApi }) => {
    // 2026-08-17: the seeded approver is the OWNER (the hardware template
    // staffs Owner + Cashier only). 10% is within every approver's cap.
    const res = await cashierApi.postRaw('/discounts/approve', {
      managerPin: SEED.approverPin, productId: orderKey, discountType: 'PERCENTAGE', discountValue: 10,
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()).data;
    expect(body.approved).toBe(true);
    expect(body.approvalToken).toBeTruthy();
  });

  test('POS-018 the owner’s unlimited cap approves beyond the old manager limit', async ({ cashierApi }) => {
    /*
     * This case used to assert the MANAGER 15% cap refusing 25%. The seed no
     * longer creates a manager, so the cap negative moved to the API layer —
     * apps/api/test/integration/specs/discount-approval.spec.ts — where the
     * fixtures own a MANAGER user. What the seed CAN show end to end is the
     * other side of the same rule: the owner's cap is unlimited.
     */
    const res = await cashierApi.postRaw('/discounts/approve', {
      managerPin: SEED.approverPin, productId: orderKey, discountType: 'PERCENTAGE', discountValue: 25,
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).data.approved).toBe(true);
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

  test('POS-020 the owner PIN answers the approval prompt from the owner’s own session', async ({ ownerApi }) => {
    // Previously skipped because the seeded owner had no PIN; since
    // 2026-08-17 the owner IS the seed's approver (PIN 2222).
    const res = await ownerApi.postRaw('/discounts/approve', {
      managerPin: SEED.approverPin, productId: orderKey, discountType: 'PERCENTAGE', discountValue: 10,
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).data.approved).toBe(true);
  });
});
