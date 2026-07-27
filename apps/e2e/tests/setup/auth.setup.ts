import { expect, test as setup } from '@playwright/test';

import * as path from 'node:path';

import { SEED } from '../../src/api';

const authPath = (name: string) => path.resolve(__dirname, `../../.auth/${name}.json`);

/**
 * Creates one authenticated browser storage state per role. Email roles use
 * the credential form; PIN roles use the demo-tenant PIN box. The saved state
 * carries the localStorage session the app reads on boot.
 */

async function emailLogin(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  await expect(page.getByRole('banner')).toBeVisible();
}

async function pinLogin(page: import('@playwright/test').Page, pin: string) {
  await page.goto('/login');
  await page.locator('#pin').fill(pin);
  await page.getByRole('button', { name: 'PIN sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}

setup('owner storage state', async ({ page }) => {
  await emailLogin(page, SEED.owner.email, SEED.owner.password);
  await page.context().storageState({ path: authPath('owner') });
});

setup('accountant storage state', async ({ page }) => {
  await emailLogin(page, SEED.accountant.email, SEED.accountant.password);
  await page.context().storageState({ path: authPath('accountant') });
});

setup('manager storage state', async ({ page }) => {
  await pinLogin(page, SEED.managerPin);
  await page.context().storageState({ path: authPath('manager') });
});

setup('cashier storage state', async ({ page }) => {
  await pinLogin(page, SEED.cashierPin);
  await page.context().storageState({ path: authPath('cashier') });
});
