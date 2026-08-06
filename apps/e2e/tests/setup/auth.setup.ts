import { expect, test as setup } from '@playwright/test';

import * as path from 'node:path';

import { SEED } from '../../src/api';

const authPath = (name: string) => path.resolve(__dirname, `../../.auth/${name}.json`);

/**
 * Creates one authenticated browser storage state per role. Email roles use
 * the credential form; PIN roles use the PIN box. The saved state carries the
 * localStorage session the app reads on boot.
 *
 * ## Why the PIN roles sign in twice (Slice 8.8)
 *
 * PIN sign-in used to post a hard-coded `tnt_dev` tenant header, so a browser
 * that had never authenticated could still PIN in. It now uses the tenant the
 * device learned from its last successful email sign-in, which is how a real
 * terminal is commissioned. A fresh Playwright context has no such memory, so
 * these roles sign in with the owner's credentials first, sign out, and then use
 * the PIN — the tenant memory deliberately outlives sign-out.
 */

async function emailLogin(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  await expect(page.getByRole('banner')).toBeVisible();
}

async function signOut(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /account menu/i }).click();
  await page.getByRole('menuitem', { name: /log out/i }).click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
}

async function pinLogin(page: import('@playwright/test').Page, pin: string) {
  // Commission the device, then hand it to the PIN user.
  await emailLogin(page, SEED.owner.email, SEED.owner.password);
  await signOut(page);

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
