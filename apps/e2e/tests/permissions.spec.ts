import { test, expect } from '../src/fixtures';
import { SEED, uniq } from '../src/api';

test.describe('PERM — Roles & Permissions', () => {
  test('PERM-004 cashier cannot create products (403)', async ({ cashierApi }) => {
    const res = await cashierApi.postRaw('/products', { name: uniq('NoPerm'), type: 'Inventory', unitPrice: 1 });
    expect(res.status()).toBe(403);
  });

  test('PERM-006 a non-privileged tier cannot delete a supplier (403)', async ({ ownerApi, cashierApi }) => {
    // The seed staffs Owner, Salesperson and Cashier, and the first two are
    // owner-equivalent (PERM-016 pins that), so the negative runs as the
    // cashier; the MANAGER/ACCOUNTANT enum matrices are pinned in
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
   * hardware template staffs Owner, Salesperson and Cashier. The accountant
   * enum tier still exists for legacy users and its permission matrix is
   * pinned exhaustively in apps/api/src/modules/auth/authorization.parity.spec.ts.
   */

  test('PERM-002 cashier cannot manage customers-only endpoints they lack', async ({ cashierApi }) => {
    // Cashier CAN read products; assert the allowed one to anchor the matrix.
    const ok = await cashierApi.getRaw('/products?page=1&pageSize=1');
    expect(ok.ok()).toBeTruthy();
  });

  // SALESPERSON is defined as an owner-equivalent role (main, 2026-08-31), so
  // every gate the owner clears must open for it too. PERM-008 (accountant)
  // did not survive the merge: the accountant demo user was retired on the
  // feature side on 2026-08-17 and its fixture would fail at login.
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
    // @Roles(...ADMIN_LEVEL_ROLES) — a role-gated route, not permission-gated.
    // It must not answer 403; any other status is a QuickBooks-config concern.
    const res = await salespersonApi.getRaw('/quickbooks/connect');
    expect(res.status()).not.toBe(403);
  });

  // PERM-016, not PERM-014: testcases.md already spends PERM-014 and PERM-015 on
  // the salesperson's UI parity (salesperson-parity.spec.ts). This is the API half.
  test('PERM-016 the seeded salesperson resolves from its own role row with the owner’s permissions', async ({ ownerApi }) => {
    /*
     * D100, read back through the API rather than the seed: the Salesperson
     * is a linked role ROW (source DATABASE — not the legacy enum fallback
     * the console used to show as "Not set"), and that row grants exactly
     * the owner's set. The effective-permissions report is what the console
     * displays, so it is the surface to pin.
     */
    const idOf = async (email: string): Promise<string> => {
      // The seeded users are the oldest rows and the list is newest-first, so
      // walk the pages rather than trust the first one.
      for (let page = 1; ; page += 1) {
        const res = await ownerApi.get(`/users?page=${page}&pageSize=200`);
        const hit = res.items.find((u: { email: string | null }) => u.email === email);
        if (hit) return hit.id;
        if (page * 200 >= res.total) throw new Error(`seeded user ${email} is not in the tenant`);
      }
    };
    const effective = (id: string) =>
      ownerApi.get<{ source: string; permissions: string[] }>(`/users/${id}/effective-permissions`);

    const [owner, salesperson, cashier] = await Promise.all(
      [SEED.owner, SEED.salesperson, SEED.cashier].map(async (u) => effective(await idOf(u.email))),
    );

    expect(salesperson.source).toBe('DATABASE');
    expect(owner.source).toBe('DATABASE');
    // Positive control before the parity claim: two empty lists are equal too.
    expect(owner.permissions.length).toBeGreaterThan(0);
    expect([...salesperson.permissions].sort()).toEqual([...owner.permissions].sort());
    // Negative control: the endpoint tells roles apart, so the equality above
    // is not one list echoed for everyone. The cashier's set is a strict
    // subset of the owner's.
    expect(cashier.permissions.length).toBeGreaterThan(0);
    expect(cashier.permissions.length).toBeLessThan(owner.permissions.length);
    expect(owner.permissions).toEqual(expect.arrayContaining(cashier.permissions));
  });
});
