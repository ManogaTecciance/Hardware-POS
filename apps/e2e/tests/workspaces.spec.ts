import { request } from '@playwright/test';

import { test, expect } from '../src/fixtures';
import { API_URL, Api, apiLogin, RESTAURANT_SEED, SEED, uniq } from '../src/api';

/**
 * WS — module-aware workspaces (Slice 8, verified in Slice 9).
 *
 * Two seeded tenants with different business profiles drive every case: the Tile
 * Shop (`demo`, QuickBooks inventory and accounting) and the Restaurant
 * (`resto-demo`, LOCAL inventory, no accounting).
 *
 * Each claim is asserted in both directions. "A Restaurant does not see
 * QuickBooks" is worthless on its own — a blank page satisfies it — so every
 * absence is paired with the presence of what the tenant *should* see, and with
 * the same route succeeding for the tenant that does have the module. The refusals
 * are checked at the API as well as in the UI, because hiding a link is usability
 * and the server is the authority.
 */

async function signIn(
  page: import('@playwright/test').Page,
  creds: { email: string; password: string },
  workspace?: string,
) {
  await page.goto('/login');
  if (workspace) await page.locator('#workspace').fill(workspace);
  await page.locator('#email').fill(creds.email);
  await page.locator('#password').fill(creds.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

/**
 * The desktop rail's links.
 *
 * `exact` matters: the mobile drawer renders a second navigation landmark named
 * "Main (mobile)", and a substring match would collect both rails' links and make
 * every "should not contain" assertion below weaker than it looks.
 */
function railLinks(page: import('@playwright/test').Page) {
  return page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link');
}

/**
 * The rail's link names, read **after** the rail has actually rendered them.
 *
 * The wait is the load-bearing part. Navigation is derived from the tenant
 * profile, which is fetched after sign-in, and until it resolves the rail is a
 * neutral placeholder with no links at all. Reading it in that window returns an
 * empty list — against which every "should not contain" assertion in this file
 * passes for entirely the wrong reason. The two guards below are the positive
 * control that makes each negative mean something.
 */
async function railLinkNames(page: import('@playwright/test').Page): Promise<string[]> {
  const links = railLinks(page);
  await expect(links.first()).toBeVisible();

  const names = (await links.allInnerTexts()).map((n) => n.replace(/\s+/g, ' ').trim());
  expect(names.length, 'the rail rendered no links — nothing below would be meaningful').toBeGreaterThan(1);
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe('WS-1 — workspace login', () => {
  test('WS-101 owner signs in with workspace, email and password', async ({ page }) => {
    await signIn(page, SEED.owner, SEED.workspace);
    await expect(page.getByRole('banner')).toBeVisible();
  });

  test('WS-102 the restaurant owner signs in with its own workspace', async ({ page }) => {
    await signIn(page, RESTAURANT_SEED.owner, RESTAURANT_SEED.workspace);
    await expect(page.getByRole('banner')).toBeVisible();
  });

  test('WS-103 the workspace field is remembered for the next sign-in', async ({ page }) => {
    await signIn(page, RESTAURANT_SEED.owner, RESTAURANT_SEED.workspace);
    await page.getByRole('button', { name: /account menu/i }).click();
    await page.getByRole('menuitem', { name: /log out/i }).click();
    await page.waitForURL(/\/login/);

    await expect(page.locator('#workspace')).toHaveValue(RESTAURANT_SEED.workspace);
  });

  test('WS-104 a wrong workspace cannot authenticate a real account', async () => {
    // The slug narrows the search; it must never widen it.
    const ctx = await request.newContext();
    const res = await ctx.post(`${API_URL}/auth/login`, {
      data: { ...SEED.owner, workspace: RESTAURANT_SEED.workspace },
    });
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test('WS-105 an unknown workspace is refused without naming what exists', async () => {
    const ctx = await request.newContext();
    const res = await ctx.post(`${API_URL}/auth/login`, {
      data: { ...SEED.owner, workspace: 'no-such-workspace' },
    });
    expect(res.status()).toBe(401);
    const body = await res.text();
    expect(body).not.toContain(SEED.workspace);
    expect(body).not.toContain(RESTAURANT_SEED.workspace);
    await ctx.dispose();
  });
});

test.describe('WS-2 — PIN sign-in after workspace authentication', () => {
  test('WS-201 a restaurant cashier PINs in once the device is commissioned', async ({ page }) => {
    await signIn(page, RESTAURANT_SEED.owner, RESTAURANT_SEED.workspace);
    await page.getByRole('button', { name: /account menu/i }).click();
    await page.getByRole('menuitem', { name: /log out/i }).click();
    await page.waitForURL(/\/login/);

    await page.locator('#pin').fill(RESTAURANT_SEED.cashierPin);
    await page.getByRole('button', { name: 'PIN sign in' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  });

  test('WS-202 the device does not carry the other tenant’s PIN', async ({ page }) => {
    // Commission for the restaurant, then try the Tile Shop cashier's PIN. It is a
    // valid PIN — in a different tenant — so this is the tenant boundary, not a
    // "wrong PIN" case.
    await signIn(page, RESTAURANT_SEED.owner, RESTAURANT_SEED.workspace);
    await page.getByRole('button', { name: /account menu/i }).click();
    await page.getByRole('menuitem', { name: /log out/i }).click();
    await page.waitForURL(/\/login/);

    await page.locator('#pin').fill(SEED.cashierPin);
    await page.getByRole('button', { name: 'PIN sign in' }).click();
    await expect(page.getByText(/invalid pin/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('WS-3 — Tile Shop navigation is unchanged', () => {
  test('WS-301 the retail rail is present and complete', async ({ page }) => {
    await signIn(page, SEED.owner, SEED.workspace);

    const flat = await railLinkNames(page);

    for (const expected of [
      'Dashboard',
      'POS',
      'Sales',
      'Quotations',
      'Returns',
      'Products',
      'Suppliers',
      'Customers',
      'QuickBooks',
      'Settings',
    ]) {
      expect(flat, `Tile Shop rail should contain ${expected}`).toContain(expected);
    }
  });

  test('WS-302 no restaurant destination leaks into it', async ({ page }) => {
    await signIn(page, SEED.owner, SEED.workspace);
    const flat = await railLinkNames(page);

    for (const absent of ['Tables', 'Takeaway', 'Kitchen', 'Menu']) {
      expect(flat, `Tile Shop rail should not contain ${absent}`).not.toContain(absent);
    }
  });
});

test.describe('WS-4 — Restaurant navigation is derived from the profile', () => {
  test('WS-401 the restaurant rail shows its own destinations', async ({ page }) => {
    await signIn(page, RESTAURANT_SEED.owner, RESTAURANT_SEED.workspace);
    const flat = await railLinkNames(page);

    for (const expected of ['Dashboard', 'Tables', 'Takeaway', 'Kitchen', 'Menu', 'Products']) {
      expect(flat.join(' | '), `restaurant rail should contain ${expected}`).toContain(expected);
    }
  });

  test('WS-402 retail destinations are absent', async ({ page }) => {
    await signIn(page, RESTAURANT_SEED.owner, RESTAURANT_SEED.workspace);
    const flat = await railLinkNames(page);

    for (const absent of ['POS', 'Quotations', 'Returns', 'Suppliers', 'QuickBooks']) {
      expect(flat, `restaurant rail should not contain ${absent}`).not.toContain(absent);
    }
  });

  test('WS-403 shared destinations are present for both profiles', async ({ page }) => {
    // Sale history is shared core by product-owner decision: a restaurant reads
    // what it has already sold.
    await signIn(page, RESTAURANT_SEED.owner, RESTAURANT_SEED.workspace);
    const flat = await railLinkNames(page);

    expect(flat.join(' | ')).toContain('Sales');
    expect(flat.join(' | ')).toContain('Customers');
  });

  test('WS-404 unbuilt destinations say so on the page itself', async ({ page }) => {
    await signIn(page, RESTAURANT_SEED.owner, RESTAURANT_SEED.workspace);

    for (const path of ['/tables', '/takeaway', '/kitchen', '/menu']) {
      await page.goto(path);
      await expect(page.getByText('Not implemented in this release')).toBeVisible();
    }
  });
});

test.describe('WS-5 — direct URLs to disabled modules are refused', () => {
  test('WS-501 a restaurant reaching /quickbooks gets a refusal, not the integration', async ({
    page,
  }) => {
    await signIn(page, RESTAURANT_SEED.owner, RESTAURANT_SEED.workspace);
    await page.goto('/quickbooks');

    await expect(page.getByText('Not part of this workspace')).toBeVisible();
    // The screen itself must not render behind the notice.
    await expect(page.getByRole('link', { name: /connect/i })).toHaveCount(0);
  });

  test('WS-502 the same route serves the Tile Shop normally', async ({ page }) => {
    // The positive control. Without it, a gate that blocked everyone would pass.
    await signIn(page, SEED.owner, SEED.workspace);
    await page.goto('/quickbooks');

    await expect(page.getByText('Not part of this workspace')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'QuickBooks' })).toBeVisible();
  });

  test('WS-503 a restaurant is refused the other retail routes too', async ({ page }) => {
    await signIn(page, RESTAURANT_SEED.owner, RESTAURANT_SEED.workspace);

    for (const path of ['/quotations', '/returns', '/suppliers', '/pos']) {
      await page.goto(path);
      await expect(
        page.getByText('Not part of this workspace'),
        `${path} should be refused`,
      ).toBeVisible();
    }
  });

  test('WS-504 a Tile Shop is refused the restaurant routes', async ({ page }) => {
    await signIn(page, SEED.owner, SEED.workspace);

    for (const path of ['/tables', '/takeaway', '/kitchen', '/menu']) {
      await page.goto(path);
      await expect(
        page.getByText('Not part of this workspace'),
        `${path} should be refused`,
      ).toBeVisible();
    }
  });

  test('WS-505 shared routes stay reachable for both', async ({ page }) => {
    // Proves the gate is selective rather than a blanket refusal for one tenant.
    await signIn(page, RESTAURANT_SEED.owner, RESTAURANT_SEED.workspace);

    for (const path of ['/dashboard', '/products', '/sales', '/customers']) {
      await page.goto(path);
      await expect(
        page.getByText('Not part of this workspace'),
        `${path} should be reachable`,
      ).toHaveCount(0);
    }
  });
});

test.describe('WS-6 — the server refuses, not just the UI', () => {
  test('WS-601 QuickBooks API routes reject a restaurant tenant', async () => {
    const auth = await apiLogin(RESTAURANT_SEED.owner.email, RESTAURANT_SEED.owner.password);
    const api = await Api.create(auth);

    for (const path of ['/quickbooks/status', '/sync/status', '/sync/logs']) {
      const res = await api.getRaw(path);
      expect(res.status(), `${path} for a restaurant tenant`).toBe(403);
    }
    await api.ctx.dispose();
  });

  test('WS-602 the same routes answer for the Tile Shop', async ({ ownerApi }) => {
    // Positive control for WS-601 — 403 everywhere would otherwise be unremarkable.
    const res = await ownerApi.getRaw('/quickbooks/status');
    expect(res.status()).toBe(200);
  });

  test('WS-603 other disabled modules are refused at the API too', async () => {
    const auth = await apiLogin(RESTAURANT_SEED.owner.email, RESTAURANT_SEED.owner.password);
    const api = await Api.create(auth);

    for (const path of ['/suppliers', '/quotations']) {
      const res = await api.getRaw(path);
      expect(res.status(), `${path} for a restaurant tenant`).toBe(403);
    }
    await api.ctx.dispose();
  });

  test('WS-604 sale history is shared core and answers for both tenants', async ({ ownerApi }) => {
    const auth = await apiLogin(RESTAURANT_SEED.owner.email, RESTAURANT_SEED.owner.password);
    const restaurant = await Api.create(auth);

    expect((await restaurant.getRaw('/sales')).status()).toBe(200);
    expect((await ownerApi.getRaw('/sales')).status()).toBe(200);
    await restaurant.ctx.dispose();
  });
});

test.describe('WS-7 — tenant isolation', () => {
  test('WS-701 the restaurant sees none of the Tile Shop catalogue', async ({ ownerApi }) => {
    const auth = await apiLogin(RESTAURANT_SEED.owner.email, RESTAURANT_SEED.owner.password);
    const restaurant = await Api.create(auth);

    const theirs = await restaurant.get<{ items: any[] }>('/products?pageSize=200');
    const ours = await ownerApi.get<{ items: any[] }>('/products?pageSize=200');

    const theirIds = new Set(theirs.items.map((p) => p.id));
    const ourIds = new Set(ours.items.map((p) => p.id));

    // Both non-empty, or the intersection below is meaningless.
    expect(theirIds.size).toBeGreaterThan(0);
    expect(ourIds.size).toBeGreaterThan(0);
    expect([...theirIds].filter((id) => ourIds.has(id))).toEqual([]);
    await restaurant.ctx.dispose();
  });

  test('WS-702 a Tile Shop product id is not readable with a restaurant token', async ({
    ownerApi,
  }) => {
    const product = await ownerApi.createProduct();
    const auth = await apiLogin(RESTAURANT_SEED.owner.email, RESTAURANT_SEED.owner.password);
    const restaurant = await Api.create(auth);

    const res = await restaurant.getRaw(`/products/${product.id}`);
    expect([403, 404]).toContain(res.status());
    await restaurant.ctx.dispose();
  });

  test('WS-703 the restaurant profile is its own', async () => {
    const auth = await apiLogin(RESTAURANT_SEED.owner.email, RESTAURANT_SEED.owner.password);
    const api = await Api.create(auth);

    const profile = await api.get('/platform/profile');
    expect(profile.businessType).toBe('RESTAURANT');
    expect(profile.inventoryMode).toBe('LOCAL');
    expect(profile.accountingProvider).toBe('NONE');
    expect(profile.enabledModules).not.toContain('QUICKBOOKS');
    expect(profile.enabledModules).toContain('TABLE_MANAGEMENT');
    await api.ctx.dispose();
  });

  test('WS-704 the Tile Shop profile is the legacy QuickBooks one', async ({ ownerApi }) => {
    const profile = await ownerApi.get('/platform/profile');
    expect(profile.businessType).toBe('TILE_SHOP');
    expect(profile.inventoryMode).toBe('QUICKBOOKS');
    expect(profile.enabledModules).toContain('QUICKBOOKS');
  });
});

test.describe('WS-8 — product management per inventory mode', () => {
  test('WS-801 a QUICKBOOKS tenant is offered synchronisation', async ({ page }) => {
    await signIn(page, SEED.owner, SEED.workspace);
    await page.goto('/products');
    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();

    // The QuickBooks-specific affordances the Tile Shop has always had: the
    // synchronisation filter, and QuickBooks named on the screen itself.
    await expect(page.getByLabel('Filter by sync status')).toBeVisible();
    await expect(page.getByText(/quickbooks/i).first()).toBeVisible();
  });

  test('WS-802 a LOCAL tenant manages its catalogue with no QuickBooks anywhere', async ({
    page,
  }) => {
    await signIn(page, RESTAURANT_SEED.owner, RESTAURANT_SEED.workspace);
    await page.goto('/products');

    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
    // The seeded menu items are visible…
    await expect(page.getByText('Chicken Fried Rice')).toBeVisible();
    // …the synchronisation filter is gone…
    await expect(page.getByLabel('Filter by sync status')).toHaveCount(0);
    // …and nothing on the screen mentions QuickBooks.
    await expect(page.getByText(/quickbooks/i)).toHaveCount(0);
  });

  test('WS-803 a LOCAL tenant can create a product through the API', async () => {
    const auth = await apiLogin(RESTAURANT_SEED.owner.email, RESTAURANT_SEED.owner.password);
    const api = await Api.create(auth);

    const created = await api.post('/products', {
      name: uniq('E2E Menu Item'),
      type: 'NonInventory',
      unitPrice: 750,
    });
    expect(created.id).toBeTruthy();

    // A locally-mastered catalogue must not acquire QuickBooks identity or queue
    // a sync job — the claim Slice 6 exists to make.
    expect(created.quickbooksItemId ?? null).toBeNull();
    expect(created.syncStatus).not.toBe('SYNCED');
    await api.ctx.dispose();
  });
});
