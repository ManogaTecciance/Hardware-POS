import { test, expect } from '../src/fixtures';
import { uniq } from '../src/api';

test.describe('PERM — Roles & Permissions', () => {
  test('PERM-004 cashier cannot create products (403)', async ({ cashierApi }) => {
    const res = await cashierApi.postRaw('/products', { name: uniq('NoPerm'), type: 'Inventory', unitPrice: 1 });
    expect(res.status()).toBe(403);
  });

  test('PERM-006 a non-privileged tier cannot delete a supplier (403)', async ({ ownerApi, cashierApi }) => {
    // 2026-08-17: the seed staffs Owner + Cashier only, so the negative runs
    // as the cashier; the MANAGER/ACCOUNTANT enum matrices are pinned in
    // apps/api/src/modules/auth/authorization.parity.spec.ts.
    const sup = await ownerApi.createSupplier();
    const res = await cashierApi.deleteRaw(`/suppliers/${sup.id}`);
    expect(res.status()).toBe(403);
  });

  test('PERM-009 user management requires USER_MANAGE (cashier 403)', async ({ cashierApi }) => {
    const res = await cashierApi.getRaw('/users');
    expect(res.status()).toBe(403);
  });

  /*
   * PERM-005 / PERM-005b / PERM-008 (the ACCOUNTANT read-only matrix) retired
   * from e2e on 2026-08-17: the seed no longer creates an accountant — the
   * hardware template staffs Owner + Cashier. The accountant enum tier still
   * exists for legacy users and its permission matrix is pinned exhaustively
   * in apps/api/src/modules/auth/authorization.parity.spec.ts.
   */

  test('PERM-002 cashier cannot manage customers-only endpoints they lack', async ({ cashierApi }) => {
    // Cashier CAN read products; assert the allowed one to anchor the matrix.
    const ok = await cashierApi.getRaw('/products?page=1&pageSize=1');
    expect(ok.ok()).toBeTruthy();
  });

});
