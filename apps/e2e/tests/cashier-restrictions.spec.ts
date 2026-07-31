import { test, expect, AUTH } from '../src/fixtures';
import { uniq } from '../src/api';

/**
 * PERM — a cashier must not be able to add/edit products or reach settings.
 *
 * Checked at both layers deliberately: hiding a button is convenience, the API
 * guard is the actual control. A UI-only test would pass against a server that
 * happily accepted the request.
 */

test.describe('PERM — cashier cannot manage products (API)', () => {
  test('PERM-004 create product is rejected', async ({ cashierApi }) => {
    const res = await cashierApi.postRaw('/products', {
      name: uniq('Cashier Should Not Create'),
      type: 'Inventory',
      unitPrice: 100,
    });
    expect(res.status()).toBe(403);
  });

  test('PERM-004b edit product is rejected', async ({ cashierApi, ownerApi }) => {
    const product = await ownerApi.createProduct();
    const res = await cashierApi.patchRaw(`/products/${product.id}`, { unitPrice: 1 });
    expect(res.status()).toBe(403);
  });

  test('PERM-004c delete product is rejected', async ({ cashierApi, ownerApi }) => {
    const product = await ownerApi.createProduct();
    const res = await cashierApi.deleteRaw(`/products/${product.id}`);
    expect(res.status()).toBe(403);
  });

  test('PERM-004d bulk import is rejected', async ({ cashierApi }) => {
    const res = await cashierApi.postRaw('/products/import/commit', { rows: [] });
    expect(res.status()).toBe(403);
  });

  test('cashier can still READ products (POS needs the catalogue)', async ({ cashierApi }) => {
    const res = await cashierApi.getRaw('/products?page=1&pageSize=1');
    expect(res.ok()).toBeTruthy();
  });
});

test.describe('SET — cashier cannot change settings (API)', () => {
  test('SET-007a updating settings is rejected', async ({ cashierApi }) => {
    const res = await cashierApi.ctx.put(`${process.env.E2E_API_URL ?? 'http://localhost:4000/v1'}/settings`, {
      data: { documents: { companyName: 'Hacked' } },
    });
    expect(res.status()).toBe(403);
  });

  test('SET-007b resetting settings is rejected', async ({ cashierApi }) => {
    const res = await cashierApi.postRaw('/settings/reset');
    expect(res.status()).toBe(403);
  });

  test('reading settings still works (POS needs currency + tax rate)', async ({ cashierApi }) => {
    const res = await cashierApi.getRaw('/settings');
    expect(res.ok()).toBeTruthy();
  });
});

test.describe('PERM — cashier UI is locked down', () => {
  test.use({ storageState: AUTH.cashier });

  test('PERM-002 Settings is absent from the navigation', async ({ page }) => {
    await page.goto('/dashboard');
    // Assert on the link itself — `aside` matches both the desktop rail and the
    // mobile drawer, and a substring match would also catch unrelated copy.
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    // Sanity: navigation did render, so the absence above is meaningful.
    await expect(page.getByRole('link', { name: 'POS', exact: true }).first()).toBeVisible();
  });

  test('SET-007 visiting /settings directly is blocked', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText(/don’t have access to settings/i)).toBeVisible();
    // The real settings UI must not render at all.
    await expect(page.getByRole('button', { name: /^Save/ })).toHaveCount(0);
  });

  test('products list offers no add / import / edit affordances', async ({ page }) => {
    await page.goto('/products');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('link', { name: /add product/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Import' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Edit$/ })).toHaveCount(0);
  });

  test('visiting /products/new directly is blocked', async ({ page }) => {
    await page.goto('/products/new');
    await expect(page.getByText(/don’t have permission to add products/i)).toBeVisible();
  });
});
