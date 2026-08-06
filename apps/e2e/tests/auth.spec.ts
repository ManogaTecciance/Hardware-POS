import { test, expect } from '../src/fixtures';
import { API_URL, apiLogin, SEED } from '../src/api';
import { request } from '@playwright/test';

test.describe('AUTH — Sessions', () => {
  test('AUTH-001 owner logs in with valid email + password', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill(SEED.owner.email);
    await page.locator('#password').fill(SEED.owner.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    await expect(page.getByRole('banner')).toBeVisible();
  });

  /*
   * Slice 8.8 changed this case's preconditions, not its claim. PIN sign-in no
   * longer carries a hard-coded `tnt_dev` header; it uses the tenant the device
   * learned when someone last signed in with an email. So the case now commissions
   * the device first — which is what a real terminal does once, at setup — and the
   * behaviour before commissioning is asserted separately in AUTH-002b.
   */
  test('AUTH-002 cashier logs in with PIN on a commissioned device', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill(SEED.owner.email);
    await page.locator('#password').fill(SEED.owner.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));

    await page.getByRole('button', { name: /account menu/i }).click();
    await page.getByRole('menuitem', { name: /log out/i }).click();
    await page.waitForURL(/\/login/);

    await page.locator('#pin').fill(SEED.cashierPin);
    await page.getByRole('button', { name: 'PIN sign in' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  });

  test('AUTH-002b PIN sign-in is refused on a device that was never commissioned', async ({
    page,
  }) => {
    // The other half of the change. A fresh context has no tenant memory, and the
    // user is told that rather than being handed "Invalid PIN" for a correct one.
    await page.goto('/login');
    await expect(page.getByText(/signed in with an email and password on this device/i)).toBeVisible();

    await page.locator('#pin').fill(SEED.cashierPin);
    await page.getByRole('button', { name: 'PIN sign in' }).click();

    // Matched by text, not by role: Next renders its own empty `role="alert"`
    // route announcer, so a role query resolves to two elements.
    await expect(page.getByText(/not set up for PIN sign-in/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('AUTH-003 login with wrong password rejected', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill(SEED.owner.email);
    await page.locator('#password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('AUTH-004 unknown email gives generic error', async () => {
    const ctx = await request.newContext();
    const res = await ctx.post(`${API_URL}/auth/login`, {
      data: { email: 'nobody@nowhere.test', password: 'whatever123' },
    });
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('AUTH-007 cashier PIN login via API', async () => {
    const ctx = await request.newContext();
    const res = await ctx.post(`${API_URL}/auth/pin-login`, {
      data: { pin: SEED.cashierPin },
      headers: { 'X-Tenant-Id': SEED.tenantId },
    });
    expect(res.ok()).toBeTruthy();
    await ctx.dispose();
  });

  test('AUTH-008 wrong PIN rejected', async () => {
    const ctx = await request.newContext();
    const res = await ctx.post(`${API_URL}/auth/pin-login`, {
      data: { pin: '0000' },
      headers: { 'X-Tenant-Id': SEED.tenantId },
    });
    expect(res.ok()).toBeFalsy();
    await ctx.dispose();
  });

  test('AUTH-010 session survives reload', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill(SEED.owner.email);
    await page.locator('#password').fill(SEED.owner.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    await page.reload();
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('AUTH-011 logout clears session', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#email').fill(SEED.owner.email);
    await page.locator('#password').fill(SEED.owner.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
    await page.getByRole('button', { name: /account menu/i }).click();
    await page.getByRole('menuitem', { name: /log out/i }).click();
    await page.waitForURL(/\/login/);
  });

  test('AUTH-013 revoked refresh token cannot mint new access token', async () => {
    const auth = await apiLogin(SEED.owner.email, SEED.owner.password);
    const ctx = await request.newContext();
    // Log out to revoke, then a refresh with the same token must fail.
    await ctx.post(`${API_URL}/auth/logout`, { data: { refreshToken: auth.refreshToken } });
    const res = await ctx.post(`${API_URL}/auth/refresh`, { data: { refreshToken: auth.refreshToken } });
    expect(res.ok()).toBeFalsy();
    await ctx.dispose();
  });

  test('AUTH-014 unauthenticated deep link redirects to login', async ({ page }) => {
    await page.goto('/products');
    await page.waitForURL(/\/login/);
  });

  test('AUTH-015 corrupt session storage drops to login', async ({ page }) => {
    await page.goto('/login');
    await page.evaluate(() => localStorage.setItem('hpos.session', '{not-json'));
    await page.goto('/products');
    await page.waitForURL(/\/login/);
  });
});
