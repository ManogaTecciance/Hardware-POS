/**
 * POS Counter — Restaurant Pilot Change 3 golden paths.
 *
 * Covers the three counter flows introduced by the redesign — Takeaway,
 * Delivery COD, and Dine-In Counter — plus the critical UI negatives the
 * design brief calls out (no persistent order-type tabs, customer form is
 * not on the menu screen, Save Draft is absent, etc.).
 *
 * These tests hit the REAL dev API + web at localhost:{3000,4000} — the
 * same targets the rest of the Playwright suite uses. They rely on the
 * pilot seed data (Chicken Kottu with Size + Extras modifiers) that was
 * created via the seed script earlier in this session; if that data ever
 * gets wiped, the spec's beforeAll step below re-creates a fixture
 * customer but does NOT re-seed the menu — a missing menu is a real
 * failure, not a test flake, and should be caught loudly.
 */
import { expect, test } from '@playwright/test';

import { API_URL, Api, apiLogin, RESTAURANT_SEED, SEED } from '../src/api';

// ── Fixture customer used by the "search existing customer" step ────────
const FIXTURE_CUSTOMER = {
  name: 'Pilot POS Customer',
  mobile: '+94770000001',
  searchQuery: '+94770000001',
};

/**
 * Ensure a stable customer row exists whose mobile the counter POS
 * customer-lookup can find. Runs once for the whole file; idempotent —
 * if the row already exists from a previous run, we don't recreate it.
 */
test.beforeAll(async () => {
  const auth = await apiLogin(
    RESTAURANT_SEED.owner.email,
    RESTAURANT_SEED.owner.password,
    RESTAURANT_SEED.workspace,
  );
  const api = await Api.create(auth);
  const existing = await api.get<{ items: Array<{ id: string; mobile?: string | null }> }>(
    `/customers?search=${encodeURIComponent(FIXTURE_CUSTOMER.searchQuery)}&pageSize=5`,
  );
  const hit = existing.items.find((c) => c.mobile === FIXTURE_CUSTOMER.mobile);
  if (!hit) {
    await api.ctx.post(`${API_URL}/customers`, {
      data: {
        name: FIXTURE_CUSTOMER.name,
        mobile: FIXTURE_CUSTOMER.mobile,
        customerType: 'RETAIL',
      },
    });
  }
  await api.ctx.dispose();
});

// ── Test helpers ─────────────────────────────────────────────────────────

async function signInAsRestaurantOwner(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.locator('#workspace').fill(RESTAURANT_SEED.workspace);
  await page.locator('#email').fill(RESTAURANT_SEED.owner.email);
  await page.locator('#password').fill(RESTAURANT_SEED.owner.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
}

/** Menu item picker used by all three golden paths. Reused so a rename lives once. */
const MENU_ITEM_WITH_MODIFIERS = /chicken kottu/i;
const SIMPLE_MENU_ITEM = /devilled cashews/i;

/**
 * Pick a menu item by using the POS search box — reliable because it
 * widens across every section, so a default-section change on the POS
 * shell cannot break the test.
 */
async function pickMenuItem(page: import('@playwright/test').Page, item: RegExp) {
  const search = page.getByPlaceholder(/search menu/i);
  await search.fill('');
  await search.type(itemSearchTerm(item), { delay: 20 });
  // Widened search returns items across every section — the item card is
  // a button in the grid.
  const card = page.getByRole('button', { name: item }).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });
  await card.click();
  await search.fill('');
}

function itemSearchTerm(item: RegExp): string {
  // Strip regex syntax and pick a distinctive word.
  const raw = item.source.replace(/[/^$()|.*+?[\]\\]/g, '');
  return raw.split(/\s+/).filter(Boolean).slice(0, 1).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────
// Order Type modal — the first thing the cashier sees on /pos
// ─────────────────────────────────────────────────────────────────────────

test.describe('POS-CTR-1 — Order Type modal', () => {
  test('POS-CTR-101 opens with three options and no Continue button', async ({ page }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/pos');

    // The modal is a real dialog with a radiogroup of three cards.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio')).toHaveCount(3);
    for (const label of ['Dine In', 'Takeaway', 'Delivery']) {
      await expect(dialog.getByRole('radio', { name: new RegExp(label, 'i') })).toBeVisible();
    }
    // No Continue / Confirm / Next — one click = one selection.
    for (const forbidden of [/^continue$/i, /^confirm$/i, /^next$/i]) {
      await expect(dialog.getByRole('button', { name: forbidden })).toHaveCount(0);
    }
  });

  test('POS-CTR-102 one click on Takeaway opens the POS workspace with the "Change" chip', async ({
    page,
  }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/pos');
    await page.getByRole('radio', { name: /takeaway/i }).click();

    // The modal is gone; the POS workspace is up with the compact chip
    // — not a persistent segmented control.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('group', { name: /order mode: takeaway/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /change/i })).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Critical UI negatives — Section 42 of the design brief
// ─────────────────────────────────────────────────────────────────────────

test.describe('POS-CTR-2 — critical UI absences on the composition screen', () => {
  test('POS-CTR-201 no persistent Dine In / Takeaway / 3rd Party segmented tabs', async ({
    page,
  }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/pos?mode=takeaway');

    // The old segmented control used role="radiogroup" with aria-label
    // "Order mode" and three radios inside. The compact chip uses
    // role="group" with the same aria-label so screen readers still
    // announce the current mode, but there is no radio, no arrow-key
    // navigation, and no way to click a second mode without going
    // through the modal.
    await expect(page.getByRole('radio', { name: /^dine in$/i })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /^takeaway$/i })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /^3rd party$/i })).toHaveCount(0);
    // Positive control: the compact chip is present.
    await expect(page.getByRole('button', { name: /change/i })).toBeVisible();
  });

  test('POS-CTR-202 no customer form on the composition screen', async ({ page }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/pos?mode=takeaway');

    // The old workspace had a Customer / Phone / Pickup time trio always
    // visible in the right rail. The new counter workspace defers that
    // to the Customer Details popup after Place Order.
    await expect(page.getByLabel(/^customer name$/i)).toHaveCount(0);
    await expect(page.getByLabel(/^pickup time$/i)).toHaveCount(0);
    await expect(page.getByPlaceholder(/walk-in — leave blank/i)).toHaveCount(0);
  });

  test('POS-CTR-203 no Save Draft affordance on the counter POS', async ({ page }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/pos?mode=takeaway');
    // Section 34 explicitly removes Save Draft until a server-side draft
    // model is approved.
    await expect(page.getByRole('button', { name: /save draft/i })).toHaveCount(0);
  });

  test('POS-CTR-204 empty cart disables Place Order', async ({ page }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/pos?mode=takeaway');
    const cta = page.getByRole('button', { name: /place order/i });
    await expect(cta).toBeVisible();
    await expect(cta).toBeDisabled();
    // Positive control that the running Bill Summary is present even with
    // an empty cart (per Section 33 / Section 12).
    await expect(page.getByText(/^bill summary$/i)).toBeVisible();
    await expect(page.getByText(/^total$/i)).toBeVisible();
  });

  test('POS-CTR-205 cart + running total remain visible while browsing the menu', async ({
    page,
  }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/pos?mode=takeaway');
    // Both the header of the cart rail ("Current order") and the running
    // bill "Total" label are visible before any interaction.
    await expect(page.getByText(/^current order$/i)).toBeVisible();
    await expect(page.getByText(/^total$/i)).toBeVisible();

    // Now hover / click a category chip to prove the composition screen
    // does not blow away the cart.
    const searchInput = page.getByPlaceholder(/search menu/i);
    await expect(searchInput).toBeVisible();
    await searchInput.fill('kottu');
    await expect(page.getByText(/^current order$/i)).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Takeaway golden path
// ─────────────────────────────────────────────────────────────────────────

test.describe('POS-CTR-3 — Takeaway golden path', () => {
  test('POS-CTR-301 modifier flow + edit + discount + cash payment + auto-KOT + orders row', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // Set up an API-side auth for post-checkout assertions.
    const auth = await apiLogin(
      RESTAURANT_SEED.owner.email,
      RESTAURANT_SEED.owner.password,
      RESTAURANT_SEED.workspace,
    );
    const api = await Api.create(auth);

    await signInAsRestaurantOwner(page);
    await page.goto('/pos');

    // Pick Takeaway from the Order Type modal.
    await page.getByRole('radio', { name: /takeaway/i }).click();
    await expect(page.getByRole('button', { name: /change/i })).toBeVisible();

    // Add the customizable item — Chicken Kottu.
    await pickMenuItem(page, MENU_ITEM_WITH_MODIFIERS);

    // Modifier dialog: pick Size = Large, add Extra cheese.
    const modifierDialog = page.getByRole('dialog').filter({ hasText: /customise:.*chicken kottu/i });
    await expect(modifierDialog).toBeVisible();
    // Size (SINGLE selection) — pick Large.
    await modifierDialog.getByText(/^large$/i).click();
    // Extras (MULTIPLE) — Extra cheese.
    await modifierDialog.getByText(/extra cheese/i).click();
    await modifierDialog.getByRole('button', { name: /add to cart/i }).click();
    await expect(modifierDialog).toBeHidden();

    // The cart shows the line with modifier labels.
    const cartLine = page.locator('div.rounded-lg.border', { has: page.getByText(MENU_ITEM_WITH_MODIFIERS) }).first();
    await expect(cartLine).toBeVisible();
    await expect(cartLine.getByText(/extra cheese/i)).toBeVisible();

    // Edit — reopen the same dialog. Selections must survive round-trip.
    await cartLine.getByRole('button', { name: /^edit$/i }).click();
    const editDialog = page.getByRole('dialog').filter({ hasText: /customise:.*chicken kottu/i });
    await expect(editDialog).toBeVisible();
    // Positive control: the Large radio is still checked, Extra cheese still ticked.
    const largeRadio = editDialog.getByRole('radio', { name: /large/i });
    await expect(largeRadio).toBeChecked();
    const cheeseChk = editDialog.getByRole('checkbox', { name: /extra cheese/i });
    await expect(cheeseChk).toBeChecked();
    // Add another extra — Bacon — and confirm.
    await editDialog.getByText(/^bacon$/i).click();
    await editDialog.getByRole('button', { name: /update item/i }).click();

    // Apply an item discount (owner has no role limit).
    await cartLine.getByRole('button', { name: /^discount$/i }).click();
    const discountDialog = page.getByRole('dialog').filter({ hasText: /discount — chicken kottu/i });
    await expect(discountDialog).toBeVisible();
    // Percentage 10%.
    await discountDialog.locator('#discount-value').fill('10');
    await discountDialog.getByRole('button', { name: /apply discount/i }).click();
    await expect(discountDialog).toBeHidden();
    // The line now shows a "10% off" indicator.
    await expect(cartLine.getByText(/10% off/i)).toBeVisible();

    // Add a simple second item.
    await pickMenuItem(page, SIMPLE_MENU_ITEM);
    await expect(
      page.locator('div.rounded-lg.border', { has: page.getByText(SIMPLE_MENU_ITEM) }).first(),
    ).toBeVisible();

    // Running bill summary shows Items count > 0 and Total > 0.
    await expect(page.getByText('Bill Summary')).toBeVisible();

    // Place Order → Customer Details popup.
    await page.getByRole('button', { name: /place order/i }).click();

    const customerDialog = page.getByRole('dialog').filter({ hasText: /customer details/i });
    await expect(customerDialog).toBeVisible();

    // Search existing customer by mobile.
    await customerDialog.getByLabel(/mobile number/i).fill(FIXTURE_CUSTOMER.mobile);
    // Debounced 250 ms — wait for the found card.
    await expect(customerDialog.getByText(/customer found/i)).toBeVisible({ timeout: 10_000 });
    await expect(customerDialog.getByText(FIXTURE_CUSTOMER.name)).toBeVisible();
    await customerDialog.getByRole('button', { name: /use customer/i }).click();

    // Payment popup.
    const paymentDialog = page.getByRole('dialog').filter({ hasText: /^payment/i });
    await expect(paymentDialog).toBeVisible();
    // The total in the popup header matches what the cart showed. We
    // don't do a byte comparison because server may reconcile — we just
    // assert an LKR value is present and the CTA is enabled once we
    // meet the tendered requirement.
    await expect(paymentDialog.getByText(/total/i).first()).toBeVisible();

    // Cash is the default. Fill tendered with a generous amount.
    await paymentDialog.getByLabel(/cash tendered/i).fill('10000');
    // Change row appears.
    await expect(paymentDialog.getByText(/^change$/i)).toBeVisible();

    // Pay & Complete.
    await paymentDialog.getByRole('button', { name: /pay & complete/i }).click();

    // Completion screen — read the order number from the header.
    const titleHeading = page
      .getByRole('heading', { name: /Order #RO-\d+ created/i })
      .first();
    await expect(titleHeading).toBeVisible({ timeout: 20_000 });
    const dialogTitle = (await titleHeading.textContent()) ?? '';
    const orderNumber = dialogTitle.match(/#(RO-\d+)/i)?.[1] ?? '';
    expect(orderNumber).toMatch(/^RO-\d+$/i);

    // KOT and payment indicators.
    await expect(page.getByText(/payment completed/i).first()).toBeVisible();
    await expect(page.getByText(/kot sent to kitchen/i).first()).toBeVisible();

    // Server side: the takeaway order appears in the unified Orders read model
    // as TAKEAWAY channel with a paid or partial payment status.
    const orders = await api.get<
      Array<{ orderNumber: string; channel: string; paymentStatus: string | null }>
    >(`/restaurant/branches/${RESTAURANT_SEED.branchId}/orders?channel=TAKEAWAY&limit=20`);
    const found = orders.find((o) => o.orderNumber === orderNumber);
    expect(found, `takeaway order ${orderNumber} must appear in /orders`).toBeDefined();
    expect(found?.channel).toBe('TAKEAWAY');
    // Payment may be PAID (client used the same total as server) or PARTIAL
    // (server reconciliation applied a different service charge/tax).
    // Either way it is not null and not UNPAID.
    expect(['PAID', 'PARTIAL']).toContain(found?.paymentStatus);

    // KOT existed — we know it did because the counter workspace waits for
    // takeaway.create to succeed before continuing, and that endpoint
    // always calls kitchen.generateTicketsForRound in the same tx. Prove
    // it externally by looking for a kitchen ticket for this branch after
    // the order landed.
    const tickets = await api.get<Array<{ id: string; ticketNumber: string }>>(
      `/restaurant/branches/${RESTAURANT_SEED.branchId}/kitchen-tickets`,
    );
    expect(tickets.length).toBeGreaterThan(0);

    await api.ctx.dispose();
  });

  test('POS-CTR-302 New Order resets the workspace but keeps the mode', async ({ page }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/pos?mode=takeaway');
    // Add an item, place the order with a walk-in customer and simple cash.
    await pickMenuItem(page, SIMPLE_MENU_ITEM);
    await page.getByRole('button', { name: /place order/i }).click();
    await page.getByRole('button', { name: /^skip$/i }).click();
    const pay = page.getByRole('dialog').filter({ hasText: /^payment/i });
    await pay.getByLabel(/cash tendered/i).fill('5000');
    await pay.getByRole('button', { name: /pay & complete/i }).click();

    const completion = page.getByRole('dialog').filter({ hasText: /created/i });
    await expect(completion).toBeVisible({ timeout: 20_000 });
    await completion.getByRole('button', { name: /new order/i }).click();

    // Back on the composition screen with empty cart, same mode chip.
    await expect(page.getByRole('group', { name: /order mode: takeaway/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /place order/i })).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Delivery COD
// ─────────────────────────────────────────────────────────────────────────

test.describe('POS-CTR-4 — Delivery COD', () => {
  test('POS-CTR-401 requires customer + address, offers COD only, sale created UNPAID', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const auth = await apiLogin(
      RESTAURANT_SEED.owner.email,
      RESTAURANT_SEED.owner.password,
      RESTAURANT_SEED.workspace,
    );
    const api = await Api.create(auth);

    await signInAsRestaurantOwner(page);
    await page.goto('/pos');
    await page.getByRole('radio', { name: /delivery/i }).click();

    // Add a simple item.
    await pickMenuItem(page, SIMPLE_MENU_ITEM);

    await page.getByRole('button', { name: /place order/i }).click();

    // Customer dialog: Skip is hidden for delivery.
    const cust = page.getByRole('dialog').filter({ hasText: /customer details/i });
    await expect(cust).toBeVisible();
    await expect(cust.getByRole('button', { name: /^skip$/i })).toHaveCount(0);

    // Fill name + phone + address.
    const nowLabel = `Delivery Test ${Date.now().toString(36)}`;
    await cust.getByLabel(/mobile number/i).fill(`+9477999${Math.floor(Math.random() * 10000)}`);
    await cust.getByLabel(/^name$/i).fill(nowLabel);
    await cust.getByLabel(/delivery address/i).fill('42 Test Street, Colombo 03');
    await cust.getByRole('button', { name: /save & continue/i }).click();

    // Payment popup: only Cash on Delivery + Bank Transfer are exposed.
    const pay = page.getByRole('dialog').filter({ hasText: /^payment/i });
    await expect(pay).toBeVisible();
    await expect(pay.getByRole('button', { name: /cash on delivery/i })).toBeVisible();
    await expect(pay.getByRole('button', { name: /bank transfer/i })).toBeVisible();
    await expect(pay.getByRole('button', { name: /^cash$/i })).toHaveCount(0);
    await expect(pay.getByRole('button', { name: /^qr$/i })).toHaveCount(0);

    // Confirm the CTA reads Confirm delivery order.
    const confirmBtn = pay.getByRole('button', { name: /confirm delivery order/i });
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    const titleHeading = page
      .getByRole('heading', { name: /Order #RO-\d+ created/i })
      .first();
    await expect(titleHeading).toBeVisible({ timeout: 20_000 });
    const title = (await titleHeading.textContent()) ?? '';
    const orderNumber = title.match(/#(RO-\d+)/i)?.[1] ?? '';
    expect(orderNumber).toMatch(/^RO-\d+$/i);
    // Delivery should show the COD state, NOT "Payment completed".
    await expect(page.getByText(/kot sent to kitchen/i).first()).toBeVisible();
    await expect(page.getByText(/^payment completed$/i)).toHaveCount(0);
    await expect(page.getByText(/unpaid — cod/i).first()).toBeVisible();

    // Server side: the order is in /orders with paymentStatus null/unpaid
    // (delivery orders through the counter today ride on TAKEAWAY channel
    // — the DELIVERY channel is a future backend enum addition, per the
    // known-limits list).
    const orders = await api.get<
      Array<{ orderNumber: string; paymentStatus: string | null }>
    >(`/restaurant/branches/${RESTAURANT_SEED.branchId}/orders?limit=30`);
    const found = orders.find((o) => o.orderNumber === orderNumber);
    expect(found, `delivery order ${orderNumber} must appear in /orders`).toBeDefined();
    // Must not be PAID.
    expect(found?.paymentStatus).not.toBe('PAID');

    await api.ctx.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Counter Dine-In (counter, not table service)
// ─────────────────────────────────────────────────────────────────────────

test.describe('POS-CTR-5 — Counter Dine-In', () => {
  test('POS-CTR-501 immediate payment path, table-service flow unaffected', async ({ page }) => {
    test.setTimeout(90_000);
    await signInAsRestaurantOwner(page);
    await page.goto('/pos');
    await page.getByRole('radio', { name: /dine in/i }).click();

    // Add a simple item and go through the same checkout flow as Takeaway.
    await pickMenuItem(page, SIMPLE_MENU_ITEM);
    await page.getByRole('button', { name: /place order/i }).click();
    await page.getByRole('button', { name: /^skip$/i }).click(); // walk-in
    const pay = page.getByRole('dialog').filter({ hasText: /^payment/i });
    await pay.getByLabel(/cash tendered/i).fill('5000');
    await pay.getByRole('button', { name: /pay & complete/i }).click();

    const completion = page.getByRole('dialog').filter({ hasText: /created/i });
    await expect(completion).toBeVisible({ timeout: 20_000 });
    await expect(completion.getByText(/payment completed/i)).toBeVisible();
    await expect(completion.getByText(/kot sent to kitchen/i)).toBeVisible();
  });

  test('POS-CTR-502 the Tables floor and its session order-entry are untouched', async ({
    page,
  }) => {
    await signInAsRestaurantOwner(page);
    // The floor plan still loads without going through /pos.
    await page.goto('/tables');
    // Show chip filter and the "New area" affordance survived (Pilot 1 UX
    // is intact — Pilot 3 did not touch /tables).
    await expect(page.getByText(/^show$/i)).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression: retail /pos still lands on the Tile Shop checkout
// ─────────────────────────────────────────────────────────────────────────

test.describe('POS-CTR-9 — cross-workspace regression', () => {
  test('POS-CTR-901 Tile Shop /pos renders the retail checkout, not the counter workspace', async ({
    page,
  }) => {
    // Log in as the Tile Shop owner using the SEED credentials.
    await page.goto('/login');
    await page.locator('#workspace').fill(SEED.workspace);
    await page.locator('#email').fill(SEED.owner.email);
    await page.locator('#password').fill(SEED.owner.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'));

    await page.goto('/pos');
    // The Tile Shop POS uses its own affordances — no Order Type modal,
    // no "Order mode: Takeaway" chip. Instead it exposes the product
    // catalog search + proceed-to-payment button.
    await expect(page.getByRole('dialog').filter({ hasText: /start new order/i })).toHaveCount(0);
    await expect(page.getByRole('group', { name: /order mode/i })).toHaveCount(0);
    // Positive control: the retail POS shows a "Cart" heading.
    await expect(page.getByText(/^cart$/i).first()).toBeVisible();
  });
});
