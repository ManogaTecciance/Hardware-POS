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
) {
  // D48 cont.: there is no workspace field — the email identifies the workspace.
  await page.goto('/login');
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
  test('WS-101 owner signs in with email and password — workspace resolved from the email', async ({ page }) => {
    await signIn(page, SEED.owner);
    await expect(page.getByRole('banner')).toBeVisible();
  });

  test('WS-102 the restaurant owner reaches its own workspace the same way', async ({ page }) => {
    await signIn(page, RESTAURANT_SEED.owner);
    await expect(page.getByRole('banner')).toBeVisible();
  });

  test('WS-103 the login page renders no workspace field (D48 cont.)', async ({ page }) => {
    await page.goto('/login');
    // Positive control: the real form rendered…
    await expect(page.locator('#email')).toBeVisible();
    // …and asks for no workspace.
    await expect(page.locator('#workspace')).toHaveCount(0);
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

test.describe('WS-2 — cashier sign-in is email login (D48)', () => {
  test('WS-201 a restaurant cashier signs in with email + password', async ({ page }) => {
    await signIn(page, RESTAURANT_SEED.cashier);
  });

  test('WS-202 a workspace hint cannot widen a credential across tenants', async () => {
    // A valid credential pinned to a DIFFERENT tenant's workspace — the tenant
    // boundary, not a "wrong password" case. API-level: the form carries no
    // workspace field any more, but ?workspace= links still pin one.
    const ctx = await request.newContext();
    const res = await ctx.post(`${API_URL}/auth/login`, {
      data: { ...SEED.cashier, workspace: RESTAURANT_SEED.workspace },
    });
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });
});

test.describe('WS-3 — Tile Shop navigation is unchanged', () => {
  test('WS-301 the retail rail is present and complete', async ({ page }) => {
    await signIn(page, SEED.owner);

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
    await signIn(page, SEED.owner);
    const flat = await railLinkNames(page);

    for (const absent of ['Tables', 'Takeaway', 'Kitchen', 'Menu']) {
      expect(flat, `Tile Shop rail should not contain ${absent}`).not.toContain(absent);
    }
  });
});

test.describe('WS-4 — Restaurant navigation is derived from the profile', () => {
  test('WS-401 the restaurant rail shows its own destinations', async ({ page }) => {
    // Pilot Change 2 rebuild: POS and Orders replaced the standalone Takeaway
    // entry — Takeaway is now a mode inside POS.
    //
    // D45: `Menu` is intentionally NOT in this list — the Restaurant workspace
    // authors sellable items via Products (labelled "Inventory" in the rail)
    // and the runtime POS reads them from `/restaurant/pos-catalogue`.
    await signIn(page, RESTAURANT_SEED.owner);
    const flat = await railLinkNames(page);

    for (const expected of ['Dashboard', 'POS', 'Orders', 'Kitchen', 'Tables']) {
      expect(flat.join(' | '), `restaurant rail should contain ${expected}`).toContain(expected);
    }
    // The catalogue destination is labelled "Inventory" in the Restaurant
    // rail, not "Products" — assert it explicitly so an accidental relabel
    // to "Products" would still trip a positive control.
    expect(flat.join(' | '), 'restaurant rail should contain the catalogue link').toContain('Inventory');
  });

  test('WS-402 retail-only destinations are absent from the restaurant rail', async ({ page }) => {
    // `POS` is no longer retail-only — Pilot Change 2 made it the shared entry
    // that both workspaces use, dispatched by business type inside
    // `app/(app)/pos/page.tsx`. The Quotations / Returns / Suppliers /
    // QuickBooks assertion still holds — those remain retail-only.
    //
    // D45: `Menu` joins the absent list. The `/menu` route file is retained
    // for support-only access at `?view=legacy`, but the nav entry is gone
    // for every Restaurant tenant.
    await signIn(page, RESTAURANT_SEED.owner);
    const flat = await railLinkNames(page);

    for (const absent of ['Menu', 'Quotations', 'Returns', 'Suppliers', 'QuickBooks']) {
      expect(flat, `restaurant rail should not contain ${absent}`).not.toContain(absent);
    }
  });

  test('WS-403 shared destinations are present for both profiles', async ({ page }) => {
    // Sale history is shared core by product-owner decision: a restaurant reads
    // what it has already sold.
    await signIn(page, RESTAURANT_SEED.owner);
    const flat = await railLinkNames(page);

    expect(flat.join(' | ')).toContain('Sales');
    expect(flat.join(' | ')).toContain('Customers');
  });

  test('WS-406 the restaurant CASHIER can reach the POS and place a takeaway or delivery order', async ({
    page,
  }) => {
    /*
     * D93. Every other test in this describe signs in as the OWNER, which is
     * exactly why this defect survived: the food-service `/pos` entry hung on
     * SALE_CREATE, a retail permission the till deliberately does not hold
     * (D87), so the one role whose job is ringing up takeaway and delivery
     * orders had no POS in its rail — while the server had permitted the whole
     * flow all along.
     */
    await signIn(page, RESTAURANT_SEED.cashier);
    const flat = await railLinkNames(page);

    // POSITIVE — the destination the complaint was about.
    expect(flat, 'the till needs a POS entry to place takeaway/delivery orders').toContain('POS');
    // D94 — the till watches the board too, read-only (Complete is gated on
    // KITCHEN_STATUS_UPDATE, which they do not hold).
    expect(flat, 'the till watches the kitchen board').toContain('Kitchen');
    // NEGATIVE, in the same test — a rail that rendered everything would pass
    // the lines above just as happily.
    expect(flat, 'the till should not get Settings').not.toContain('Settings');
    expect(flat, 'the till should not get Reports').not.toContain('Reports');

    // …and the screen behind the entry offers both order types.
    await page.getByRole('link', { name: 'POS', exact: true }).first().click();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Start new order')).toBeVisible({ timeout: 20_000 });

    /*
     * Matched as radios, not as text. The theme switcher in the header is also
     * a radiogroup, and each option card carries its label in a heading AND in
     * its hint — a `getByText` here resolved to two elements and failed on
     * strict mode, which would have been easy to "fix" by loosening the query
     * into something that asserts less.
     */
    await expect(page.getByRole('radio', { name: /Takeaway/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Delivery/ })).toBeVisible();
    // NEGATIVE — Dine In is the waiter's; the till cannot send to the kitchen,
    // and offering it would be offering a 403 three taps later.
    await expect(page.getByRole('radio', { name: /Dine In/ })).toHaveCount(0);
  });

  test('WS-408 the till watches the kitchen board but cannot work it', async ({ page }) => {
    /*
     * D94 (PO): the cashier gets the board. KOT_VIEW and nothing more — the
     * write controls are gated on KITCHEN_STATUS_UPDATE, which stays with
     * the people who cooked the food (D68). Since D106 the outstanding
     * board's verb depends on ticket state (Start preparing → Mark done),
     * so BOTH names are matched: the contrast is "no write verb at all",
     * not the absence of one particular label.
     *
     * Asserted as a CONTRAST against kitchen staff on the same board, because
     * "the till has no write button" is also what an empty board, a failed
     * request and a broken selector all look like. The Details count is the
     * positive control: same tickets, same page, one control missing.
     */
    const WRITE_VERB = /start preparing|mark done/i;
    await signIn(page, RESTAURANT_SEED.cashier);
    await page.goto('/kitchen');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Kitchen' })).toBeVisible({ timeout: 20_000 });

    const tillDetails = await page.getByRole('button', { name: /details/i }).count();
    const tillWriteVerbs = await page.getByRole('button', { name: WRITE_VERB }).count();
    expect(tillDetails, 'the till should see tickets on the board').toBeGreaterThan(0);
    expect(tillWriteVerbs, 'the till must not be able to work the board').toBe(0);

    /*
     * Kitchen staff in a SECOND context rather than a second sign-in on the same
     * page: re-visiting /login while already authenticated leaves the email
     * field prefilled and unfillable, and the contrast is only worth anything
     * if both halves are in one test.
     */
    const kitchenContext = await page.context().browser()!.newContext();
    try {
      const kitchenPage = await kitchenContext.newPage();
      await signIn(kitchenPage, RESTAURANT_SEED.kitchen);
      await kitchenPage.goto('/kitchen');
      await kitchenPage.waitForLoadState('networkidle');
      await expect(kitchenPage.getByRole('heading', { name: 'Kitchen' })).toBeVisible({
        timeout: 20_000,
      });

      // The control EXISTS on the same board — so the zero above is about the
      // permission, not about an empty board or a selector matching nothing.
      expect(
        await kitchenPage.getByRole('button', { name: WRITE_VERB }).count(),
        'kitchen staff must still be able to work the board',
      ).toBeGreaterThan(0);
      expect(await kitchenPage.getByRole('button', { name: /details/i }).count()).toBe(tillDetails);
    } finally {
      await kitchenContext.close();
    }
  });

  test('WS-407 a deep link to a mode the till cannot work asks instead of opening it', async ({
    page,
  }) => {
    // D93 — `?mode=` survives a bookmark and a shared link. Now that the till
    // has a POS entry, `/pos?mode=dine-in` is an ordinary thing to be sent.
    await signIn(page, RESTAURANT_SEED.cashier);
    await page.goto('/pos?mode=dine-in');
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('Start new order')).toBeVisible({ timeout: 20_000 });
    // POSITIVE CONTROL in the same test: a mode they CAN work still opens
    // directly, so the assertion above is not passing on a screen that always
    // shows the chooser.
    await page.goto('/pos?mode=takeaway');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Start new order')).toHaveCount(0);
  });

  test('WS-404 built destinations render their real feature, not the shell text', async ({
    page,
  }) => {
    // Pilot Change 2 replaced the standalone /takeaway board with the
    // POS-mode workspace; /takeaway now 307-redirects to /pos?mode=takeaway.
    // /orders is the new unified queue. Every route below asserts a small
    // positive signal so a page that renders nothing at all cannot silently
    // satisfy the "no shell copy" negative.
    await signIn(page, RESTAURANT_SEED.owner);

    const positiveSignals: Record<string, RegExp> = {
      '/tables': /show/i,          // area filter label at the top of the floor
      '/kitchen': /refreshes/i,    // "Refreshes every 5 s." footer
      // D45: `/menu` now renders the "moved to Products" redirect card for
      // a Restaurant tenant. The positive signal shifts from the old menu
      // browser header to the redirect card's CTA — the page is *some*
      // real feature, just a different one, and the shell-copy negative
      // above still guards against a fallthrough render.
      '/menu': /go to products|this page has moved/i,
      '/pos?mode=takeaway': /place order|active menu|customer/i,
      '/orders': /live queue|no orders/i,
    };

    for (const [path, signal] of Object.entries(positiveSignals)) {
      await page.goto(path);
      await expect(
        page.getByText('Not implemented in this release'),
        `${path} should no longer carry the shell copy`,
      ).toHaveCount(0);
      await expect(
        page.getByText(signal).first(),
        `${path} should render a real feature affordance`,
      ).toBeVisible();
    }
  });

  test('WS-405 the /takeaway redirect keeps existing bookmarks working', async ({ page }) => {
    // The old top-level `/takeaway` page was deleted in Slice E; middleware
    // redirects `/takeaway*` → `/pos?mode=takeaway`. Verifies the shim
    // documented in `apps/web/src/middleware.ts`.
    await signIn(page, RESTAURANT_SEED.owner);
    await page.goto('/takeaway');
    await page.waitForURL(/\/pos\?mode=takeaway/);
    expect(page.url()).toContain('/pos?mode=takeaway');
  });
});

test.describe('WS-5 — direct URLs to disabled modules are refused', () => {
  test('WS-501 a restaurant reaching /quickbooks gets a refusal, not the integration', async ({
    page,
  }) => {
    await signIn(page, RESTAURANT_SEED.owner);
    await page.goto('/quickbooks');

    await expect(page.getByText('Not part of this workspace')).toBeVisible();
    // The screen itself must not render behind the notice.
    await expect(page.getByRole('link', { name: /connect/i })).toHaveCount(0);
  });

  test('WS-502 the same route serves the Tile Shop normally', async ({ page }) => {
    // The positive control. Without it, a gate that blocked everyone would pass.
    await signIn(page, SEED.owner);
    await page.goto('/quickbooks');

    await expect(page.getByText('Not part of this workspace')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'QuickBooks' })).toBeVisible();
  });

  test('WS-503 a restaurant is refused the other retail routes too', async ({ page }) => {
    // `/pos` is no longer retail-only after Pilot Change 2 — it dispatches
    // by business type. The three routes below remain retail-only.
    await signIn(page, RESTAURANT_SEED.owner);

    for (const path of ['/quotations', '/returns', '/suppliers']) {
      await page.goto(path);
      await expect(
        page.getByText('Not part of this workspace'),
        `${path} should be refused`,
      ).toBeVisible();
    }
  });

  test('WS-504 a Tile Shop is refused the restaurant routes', async ({ page }) => {
    // `/takeaway` was replaced by the POS-mode workspace in Pilot Change 2;
    // its middleware redirect points at `/pos?mode=takeaway`, which for a
    // Tile Shop resolves to the retail POS via business-type dispatch —
    // so it never renders the module-gate refusal. `/orders` is the new
    // TABLE_MANAGEMENT-gated route that a Tile Shop cannot reach.
    await signIn(page, SEED.owner);

    for (const path of ['/tables', '/orders', '/kitchen', '/menu']) {
      await page.goto(path);
      await expect(
        page.getByText('Not part of this workspace'),
        `${path} should be refused`,
      ).toBeVisible();
    }
  });

  test('WS-505 shared routes stay reachable for both', async ({ page }) => {
    // Proves the gate is selective rather than a blanket refusal for one tenant.
    await signIn(page, RESTAURANT_SEED.owner);

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
    await signIn(page, SEED.owner);
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
    await signIn(page, RESTAURANT_SEED.owner);
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
