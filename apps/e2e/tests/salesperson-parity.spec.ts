import type { Page } from '@playwright/test';

import { AUTH, expect, test } from '../src/fixtures';

/**
 * PERM-014 / PERM-015 — the Salesperson gets the owner's UI (D108).
 *
 * The permission tables already say the two roles are equal; these look at
 * what a person actually gets. The rail is the visible shape of a role — it is
 * derived from permissions and modules and nothing else — so "the same rail"
 * is the closest thing to "the same screens" a browser can assert in one
 * place. The discount check is the one interaction where the owner's
 * unlimited ceiling shows: no approval prompt, and the server agrees.
 */

/**
 * Same reading as `workspaces.spec.ts`: the desktop rail only, and only once
 * it has rendered — navigation waits on the tenant profile, and before that
 * resolves the rail is an empty placeholder against which every equality
 * would hold for the wrong reason. The length guard is the positive control.
 */
async function railLinkNames(page: Page): Promise<string[]> {
  const links = page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link');
  await expect(links.first()).toBeVisible();
  const names = (await links.allInnerTexts()).map((n) => n.replace(/\s+/g, ' ').trim());
  expect(names.length, 'the rail rendered no links — nothing below would be meaningful').toBeGreaterThan(1);
  return names;
}

async function railFor(browser: import('@playwright/test').Browser, storageState: string): Promise<string[]> {
  const context = await browser.newContext({ storageState });
  try {
    const page = await context.newPage();
    await page.goto('/dashboard');
    return await railLinkNames(page);
  } finally {
    await context.close();
  }
}

test.describe('PERM — Salesperson parity with the owner (D108)', () => {
  test('PERM-014 the salesperson’s rail is the owner’s rail, and not the cashier’s', async ({ browser }) => {
    const [salesperson, owner, cashier] = await Promise.all([
      railFor(browser, AUTH.salesperson),
      railFor(browser, AUTH.owner),
      railFor(browser, AUTH.cashier),
    ]);

    expect(salesperson).toEqual(owner);
    // NEGATIVE — the equality above is not "every rail looks the same": the
    // cashier's is narrower, and the owner-only destinations are the difference.
    expect(salesperson).not.toEqual(cashier);
    for (const ownerOnly of ['Settings', 'QuickBooks']) {
      expect(salesperson, `salesperson rail should contain ${ownerOnly}`).toContain(ownerOnly);
      expect(cashier, `cashier rail should not contain ${ownerOnly}`).not.toContain(ownerOnly);
    }
  });

  test('PERM-015 a 50% line discount needs no approval from a salesperson — and does from a cashier', async ({
    salespersonApi,
    cashierApi,
  }) => {
    // The server, not the dialog, is the boundary: it recomputes the discount
    // against the actor's ceiling and refuses anything over it without an
    // approval token. Unlimited for the owner's set, zero for the till.
    const product = await salespersonApi.createProduct({ quantityOnHand: 100, unitPrice: 1000 });
    const order = (actorProductId: string) => ({
      branchId: 'brn_dev',
      registerId: 'reg_dev',
      items: [{ productId: actorProductId, quantity: 1, discountType: 'PERCENTAGE', discountValue: 50 }],
      payments: [{ method: 'CASH', amount: 10_000_000 }],
    });

    const sale = await salespersonApi.post('/sales/complete', order(product.id));
    const detail = await salespersonApi.get(`/sales/${sale.id}`);
    expect(Number(detail.items[0].discountAmount)).toBe(500);

    const refused = await cashierApi.postRaw('/sales/complete', order(product.id));
    expect(refused.ok()).toBeFalsy();
    expect(refused.status()).toBeGreaterThanOrEqual(400);
    expect(refused.status()).toBeLessThan(500);
  });
});
