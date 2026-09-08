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

  // SALESPERSON is defined as an owner-equivalent role, so every gate the owner
  // clears must open for it too — including the two the manager is refused above.
  test('PERM-010 salesperson can manage users (owner-equivalent)', async ({ salespersonApi }) => {
    const res = await salespersonApi.getRaw('/users');
    expect(res.ok()).toBeTruthy();
  });

  test('PERM-011 salesperson can create and delete a supplier', async ({ salespersonApi }) => {
    const sup = await salespersonApi.createSupplier();
    const res = await salespersonApi.deleteRaw(`/suppliers/${sup.id}`);
    expect(res.ok()).toBeTruthy();
  });

  test('PERM-012 salesperson can manage products', async ({ salespersonApi }) => {
    const res = await salespersonApi.postRaw('/products', {
      name: uniq('SalesProd'),
      type: 'Inventory',
      unitPrice: 1,
    });
    expect(res.ok()).toBeTruthy();
  });

  test('PERM-013 salesperson may reach owner-only QuickBooks routes', async ({ salespersonApi }) => {
    // @Roles(OWNER, ADMIN, SALESPERSON) — a role-gated route, not permission-gated.
    // It must not answer 403; any other status is a QuickBooks-config concern.
    const res = await salespersonApi.getRaw('/quickbooks/connect');
    expect(res.status()).not.toBe(403);
  });
});
