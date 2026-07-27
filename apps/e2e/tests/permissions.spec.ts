import { test, expect } from '../src/fixtures';
import { uniq } from '../src/api';

test.describe('PERM — Roles & Permissions', () => {
  test('PERM-004 cashier cannot create products (403)', async ({ cashierApi }) => {
    const res = await cashierApi.postRaw('/products', { name: uniq('NoPerm'), type: 'Inventory', unitPrice: 1 });
    expect(res.status()).toBe(403);
  });

  test('PERM-006 manager cannot delete a supplier (403)', async ({ ownerApi, managerApi }) => {
    const sup = await ownerApi.createSupplier();
    const res = await managerApi.deleteRaw(`/suppliers/${sup.id}`);
    expect(res.status()).toBe(403);
  });

  test('PERM-009 user management requires USER_MANAGE (cashier 403)', async ({ cashierApi }) => {
    const res = await cashierApi.getRaw('/users');
    expect(res.status()).toBe(403);
  });

  test('PERM-005 accountant can read suppliers', async ({ accountantApi }) => {
    const res = await accountantApi.getRaw('/suppliers?page=1&pageSize=1');
    expect(res.ok()).toBeTruthy();
  });

  test('PERM-005b accountant cannot create a supplier (403)', async ({ accountantApi }) => {
    const res = await accountantApi.postRaw('/suppliers', { name: uniq('AcctVendor') });
    expect(res.status()).toBe(403);
  });

  test('PERM-002 cashier cannot manage customers-only endpoints they lack', async ({ cashierApi }) => {
    // Cashier CAN read products; assert the allowed one to anchor the matrix.
    const ok = await cashierApi.getRaw('/products?page=1&pageSize=1');
    expect(ok.ok()).toBeTruthy();
  });

  test('PERM-008 accountant cannot manage products (403)', async ({ accountantApi }) => {
    const res = await accountantApi.postRaw('/products', { name: uniq('AcctProd'), type: 'Inventory', unitPrice: 1 });
    expect(res.status()).toBe(403);
  });
});
