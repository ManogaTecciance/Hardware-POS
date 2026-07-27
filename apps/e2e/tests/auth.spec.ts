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

  test('AUTH-002 cashier logs in with PIN (demo tenant)', async ({ page }) => {
    await page.goto('/login');
    await page.locator('#pin').fill(SEED.cashierPin);
    await page.getByRole('button', { name: 'PIN sign in' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
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
