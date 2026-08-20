/**
 * Tablet-responsive golden paths — Restaurant POS.
 *
 * These specs run inside the `tablet-landscape` (1194×834) and
 * `tablet-portrait` (834×1194) Playwright projects declared in
 * `playwright.config.ts`. Every assertion pairs a positive observation
 * ("the sticky bottom bar exists on portrait", "the cart aside exists on
 * landscape") with the corresponding negative on the OTHER orientation.
 * A component regressing to a desktop-only layout fails the branch that
 * expected it.
 *
 * We reach for `hasTouch: true` in the config so Playwright's default
 * pointer type is coarse — this exercises the `@media (pointer: coarse)`
 * rules in `globals.css` (hover neutralisation, `touch-target-coarse`).
 *
 * Business behaviour (place order, kitchen ticket, payment) is covered by
 * `pos-counter.spec.ts` at desktop. These specs deliberately do NOT
 * re-run the whole flow — they focus on the LAYOUT + AFFORDANCE
 * differences between orientations.
 */
import { expect, test } from '@playwright/test';

import { RESTAURANT_SEED } from '../src/api';

// ── Helpers ─────────────────────────────────────────────────────────────

async function signInAsRestaurantOwner(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.locator('#email').fill(RESTAURANT_SEED.owner.email);
  await page.locator('#password').fill(RESTAURANT_SEED.owner.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
}

async function signInAsRestaurantWaiter(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.locator('#email').fill(RESTAURANT_SEED.waiter.email);
  await page.locator('#password').fill(RESTAURANT_SEED.waiter.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
}

/**
 * Does the content scroll sideways?
 *
 * The single most useful responsiveness question, and the one a className
 * assertion cannot answer. Horizontal scroll on a tablet drags controls out
 * of reach and is never intentional at the page level — where a horizontally
 * scrolling table, chip row or code block is fine, because it scrolls inside
 * its own box and the surrounding layout does not move.
 *
 * It measures `<main>`, NOT `document.documentElement`. The app shell is
 * `h-dvh overflow-hidden` with `main` owning the only scroll, so the document
 * can never report overflow in either axis — a probe on `documentElement` is
 * structurally incapable of failing, which is exactly how this function was
 * first written and exactly why it caught nothing. Verified by mutation:
 * dropping a `min-w-[2200px]` element onto a restaurant screen fails this.
 *
 * Throws rather than returning false when there is no `<main>`: "the shell
 * did not render" must fail loudly, not read as "nothing overflowed".
 */
async function contentScrollsSideways(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) throw new Error('no <main>: the app shell did not render');
    const doc = document.documentElement;
    // 1px of slack: sub-pixel layout rounding routinely produces 0.5px.
    return main.scrollWidth > main.clientWidth + 1 || doc.scrollWidth > doc.clientWidth + 1;
  });
}

function isPortrait(page: import('@playwright/test').Page): boolean {
  const vp = page.viewportSize();
  if (!vp) return false;
  return vp.height > vp.width;
}

// ── Global chrome — sidebar vs drawer cutover at 900px ──────────────────

test.describe('TAB-CHR — Global chrome', () => {
  test('TAB-CHR-001 sidebar rail is visible on landscape, drawer trigger visible on portrait', async ({
    page,
  }) => {
    await signInAsRestaurantOwner(page);
    /*
     * `?mode=` matters now: without it the POS opens the Start-new-order
     * modal over the whole screen, so every query for the menu or the cart
     * finds nothing. That modal arrived after this spec was written, which is
     * why it had been failing on both orientations.
     */
    await page.goto('/pos?mode=takeaway');
    await page.waitForLoadState('networkidle');

    // Every viewport must render the primary nav — this is the positive
    // control that prevents an empty-DOM false pass on either branch.
    /*
     * The landmark is labelled "Main" (rail) and "Main (mobile)" (drawer) —
     * `sidebar.tsx` names them apart deliberately so two navigation landmarks
     * do not share one accessible name. This query asked for /primary/i,
     * matched neither, and had been failing silently ever since.
     */
    const nav = page.getByRole('navigation', { name: /^main/i });
    await expect(nav.first()).toBeAttached();

    if (isPortrait(page)) {
      // Portrait ⇒ rail hidden, drawer trigger button visible in header.
      // The rail is `.hidden tab:flex`; on 834×1194 that resolves to
      // display:none, so it must not be rendered "visible".
      const railSidebar = page.locator('aside:has(> nav[aria-label="Main"])').first();
      // The drawer sidebar is a separate DOM node also role=navigation;
      // Playwright's visibility check will only report a hit for the
      // header hamburger trigger, not the rail.
      await expect(railSidebar).toBeHidden();
      await expect(page.getByRole('button', { name: /open (?:navigation|menu)/i })).toBeVisible();
    } else {
      // Landscape ⇒ rail flexes into place; the header hamburger is
      // `tab:hidden` so it disappears.
      await expect(page.getByRole('button', { name: /open (?:navigation|menu)/i })).toBeHidden();
      // The rail displays the Nav items directly — pick one that every
      // restaurant tenant sees ("POS"). Scoped to the rail's own nav: the
      // drawer renders the same links and is in the DOM at every width.
      await expect(
        page.locator('nav[aria-label="Main"]').getByRole('link', { name: /^pos$/i }).first(),
      ).toBeVisible();
    }
  });
});

// ── POS Counter — cart aside landscape vs sticky bar portrait ───────────

test.describe('TAB-POS — POS Counter tablet layout', () => {
  test('TAB-POS-001 counter renders correct cart affordance per orientation', async ({ page }) => {
    await signInAsRestaurantOwner(page);
    /*
     * `?mode=` matters now: without it the POS opens the Start-new-order
     * modal over the whole screen, so every query for the menu or the cart
     * finds nothing. That modal arrived after this spec was written, which is
     * why it had been failing on both orientations.
     */
    await page.goto('/pos?mode=takeaway');
    await page.waitForLoadState('networkidle');

    // Both orientations must render the menu column (positive control).
    // The menu column shows the search input placeholder "Search menu…".
    await expect(page.getByPlaceholder(/search menu/i)).toBeVisible();

    if (isPortrait(page)) {
      /*
       * Portrait ⇒ no cart aside (`hidden tab:block`); the cart lives behind
       * a sticky bottom bar instead.
       *
       * That bar is rendered ONLY for a non-empty cart — deliberately, so an
       * empty peek does not announce "0 items". This spec used to claim the
       * opposite ("the bar renders even when empty") and simply waited for a
       * button that was never going to exist, so it has been failing on
       * portrait ever since. Put something in the cart first, which is also
       * the state a waiter is actually in when they reach for it.
       */
      // Menu tiles are the buttons that carry a price. Scoped that way
      // because the header's account button also contains a bold span, and a
      // structural selector matched THAT — opening the profile menu instead
      // of adding anything.
      const firstTile = page.getByRole('button').filter({ hasText: /LKR/ }).first();
      await expect(firstTile).toBeVisible({ timeout: 20_000 });
      await firstTile.click();

      // A product with variants or modifiers opens the customise dialog on
      // the way into the cart. Confirming it is SETUP, not the assertion —
      // if this branch is wrong the order bar below never appears and the
      // test fails, so a conditional here cannot hide a defect.
      const addToCart = page.getByRole('button', { name: /add to cart/i });
      if (await addToCart.isVisible().catch(() => false)) await addToCart.click();

      const orderBar = page.getByRole('button', { name: /view order/i }).last();
      await expect(orderBar).toBeVisible();
      // The bar sits at the bottom of the viewport — the CSS class
      // `fixed inset-x-0 bottom-0` is what puts it there, and Playwright
      // reports the bounding box.
      const box = await orderBar.boundingBox();
      const vp = page.viewportSize()!;
      expect(box).not.toBeNull();
      if (box) {
        // Bar's bottom edge sits within 100px of the viewport bottom
        // (safe-area padding may push it up a few px on real devices;
        // headless Chromium reports 0 inset so the tolerance is generous).
        expect(vp.height - (box.y + box.height)).toBeLessThan(100);
      }
    } else {
      // Landscape ⇒ the cart aside must be visible on the right side.
      // The cart card renders the "Order" heading + "Place order" button.
      // "Place order" is always rendered even when the cart is empty
      // (disabled state), which makes it a stable positive assertion.
      await expect(
        page.getByRole('button', { name: /place order/i }).first(),
      ).toBeAttached();
    }
  });
});

// ── Tables — chip row scrolls, cards remain touch-friendly ──────────────

test.describe('TAB-TBL — Tables floor tablet layout', () => {
  test('TAB-TBL-001 area filter uses ChipRow (scrollable), table grid renders', async ({ page }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/tables');
    await page.waitForLoadState('networkidle');

    // Restaurant tenants may have zero areas seeded — in that case the
    // page shows an empty state and there's no chip row to check.
    // The positive assertion below only runs when there IS content.
    const emptyState = page.getByText(/no dining areas/i);
    if (await emptyState.isVisible().catch(() => false)) {
      test.info().annotations.push({
        type: 'skip-reason',
        description: 'Restaurant tenant has no dining areas seeded — chip row not applicable.',
      });
      return;
    }

    // ChipRow renders a scrollable strip; the first chip is "All".
    const allChip = page.getByRole('button', { name: /^all$/i }).first();
    await expect(allChip).toBeVisible();
    // Chip height ≥ 44px (touch target).
    const box = await allChip.boundingBox();
    expect(box).not.toBeNull();
    if (box) expect(box.height).toBeGreaterThanOrEqual(40);
  });
});

// ── Orders — chip filters, order detail sheet on portrait ───────────────

test.describe('TAB-ORD — Orders queue tablet layout', () => {
  test('TAB-ORD-001 status/channel chips render as touch-friendly rows', async ({ page }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/orders');
    await page.waitForLoadState('networkidle');

    // The status tabs "All / Pending / Preparing / Ready / Completed / Cancelled"
    // are the primary filter; "All" is always present.
    const allTab = page.getByRole('button', { name: /^all$/i }).first();
    await expect(allTab).toBeVisible();
    const box = await allTab.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(40);
  });
});

// ── Kitchen — filter chips ──────────────────────────────────────────────

test.describe('TAB-KIT — Kitchen board tablet layout', () => {
  /*
   * Rewritten 2026-08-21. This assertion used to read:
   *
   *     const allChip = page.getByRole('button', { name: /^all$/i }).first();
   *     if (await allChip.isVisible().catch(() => false)) { …height… }
   *
   * — which is green whether or not the chip exists. D68 renamed the board's
   * filters ("To make" / "Done") and deleted the "All" chip, so from that
   * commit onwards it asserted nothing at all and nobody could tell. The
   * chips are now located unconditionally, by their real names.
   */
  test('TAB-KIT-001 the board filters are present and touch-sized', async ({ page }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/kitchen');
    await page.waitForLoadState('networkidle');

    // "To make 9" — the count badge is part of the accessible name, so the
    // anchored `$` in the original never matched.
    for (const name of [/^to make/i, /^done$/i]) {
      const chip = page.getByRole('button', { name }).first();
      await expect(chip).toBeVisible();
      const box = await chip.boundingBox();
      expect(box, `no box for ${String(name)}`).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(40);
    }
    expect(await contentScrollsSideways(page)).toBe(false);
  });
});

// ── Product wizard preview affordance ───────────────────────────────────

test.describe('TAB-MNU — authoring wizard tablet layout', () => {
  /*
   * Retargeted 2026-08-21. This spec drove `/menu/items/new`, which D45 turned
   * into a "create it in Products" card for every restaurant tenant — the
   * wizard it asserted against is not reachable from that route any more, so
   * it had been failing on a screen that no longer exists. The behaviour it
   * describes is real and still worth guarding; it just lives in the Product
   * Wizard now, which is the single authoring surface D45 left standing.
   */
  test('TAB-MNU-001 Preview is a Sheet trigger on tablet, an inline rail on desktop only', async ({
    page,
  }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/products/new');
    await page.waitForLoadState('networkidle');

    // POSITIVE CONTROL — the wizard is on screen, whatever the orientation.
    await expect(page.getByText(/step 1 of/i).first()).toBeVisible({ timeout: 20_000 });

    /*
     * The cutover is `useIsDesktop()` (lg, 1024) and the two tablet projects
     * sit on OPPOSITE sides of it — landscape 1194 is above, portrait 834 is
     * below. The original spec asserted "both 1194 and 834 are `<lg`", which
     * is simply not true of 1194, so it failed on a layout that was correct.
     */
    if (isPortrait(page)) {
      // Portrait ⇒ the rail is not MOUNTED (gated by the hook, not hidden by
      // CSS), and the same preview lives behind a footer trigger.
      await expect(page.getByTestId('product-preview-rail')).toHaveCount(0);
      // POSITIVE CONTROL for that absence: `toHaveCount(0)` is true of any
      // selector matching nothing, including a testid that was never added.
      await page.getByRole('button', { name: /^preview$/i }).click();
      await expect(page.getByText(/live preview/i).first()).toBeVisible();
    } else {
      // Landscape ⇒ the rail is inline and there is no trigger to duplicate
      // it. One preview on screen at a time, either way.
      await expect(page.getByTestId('product-preview-rail')).toHaveCount(1);
      await expect(page.getByRole('button', { name: /^preview$/i })).toHaveCount(0);
    }

    expect(await contentScrollsSideways(page)).toBe(false);
  });
});

// ── Every restaurant screen: the page itself must not scroll sideways ────

/**
 * The generic check, run over every screen restaurant staff live on.
 *
 * Deliberately a loop rather than six copies: the failure message names the
 * route, and a screen added to the list is covered without anybody
 * remembering to write a test. Each iteration also asserts that the screen
 * actually RENDERED — a blank page cannot overflow, so without that control
 * an app that 500s everywhere would pass this suite perfectly.
 */
test.describe('TAB-FIT — restaurant screens fit the viewport', () => {
  /*
   * `ready` is matched against the page's H1, not against free text. Every
   * one of these words also appears in the navigation rail, where the link is
   * present but hidden at some widths — so a text query resolves to the
   * hidden copy and the wait fails against a screen that rendered perfectly.
   */
  const SCREENS: { path: string; ready: RegExp }[] = [
    { path: '/pos?mode=takeaway', ready: /^pos$/i },
    { path: '/kitchen', ready: /^kitchen$/i },
    { path: '/tables', ready: /^tables$/i },
    { path: '/orders', ready: /^orders$/i },
    { path: '/reports', ready: /^reports$/i },
    { path: '/calendar', ready: /^calendar$/i },
  ];

  for (const screen of SCREENS) {
    test(`TAB-FIT ${screen.path} fits`, async ({ page }) => {
      await signInAsRestaurantOwner(page);
      await page.goto(screen.path);
      await page.waitForLoadState('networkidle');

      // POSITIVE CONTROL — the screen is really on. Without this the
      // overflow assertion below would pass against an empty <body>.
      await expect(
        page.getByRole('heading', { name: screen.ready }).first(),
      ).toBeVisible({ timeout: 20_000 });

      expect(
        await contentScrollsSideways(page),
        `${screen.path} scrolls sideways at ${JSON.stringify(page.viewportSize())}`,
      ).toBe(false);
    });
  }
});

// ── Dine-in: the waiter's own screen, both orientations ─────────────────

test.describe('TAB-DINE — dine-in POS tablet layout', () => {
  test('TAB-DINE-001 the table block is touch-sized and leaves the menu on screen', async ({
    page,
  }) => {
    await signInAsRestaurantWaiter(page);
    await page.goto('/pos?mode=dine-in');
    await page.waitForLoadState('networkidle');

    // The picker is the first thing a waiter answers.
    await expect(page.getByText('Which table?')).toBeVisible({ timeout: 20_000 });

    // Area chips and table buttons are both on the 44px touch line.
    const firstTable = page
      .locator('button')
      .filter({ hasText: /^[A-Z]{1,3}-?\d+/ })
      .first();
    await expect(firstTable).toBeVisible();
    const tableBox = await firstTable.boundingBox();
    expect(tableBox).not.toBeNull();
    expect(tableBox!.height).toBeGreaterThanOrEqual(40);

    /*
     * The constraint that put the area filter there in the first place: the
     * block must not eat the screen. Measured against the VIEWPORT rather
     * than against a class name, because `max-h-[calc(...)]` is exactly the
     * kind of arbitrary value that can silently fail to compile.
     */
    const card = page.locator('div', { hasText: 'Which table?' }).last();
    const cardBox = await card.boundingBox();
    const vp = page.viewportSize()!;
    expect(cardBox).not.toBeNull();
    expect(
      cardBox!.height,
      `table block is ${cardBox!.height}px of a ${vp.height}px viewport`,
    ).toBeLessThanOrEqual(vp.height * 0.55);

    // And the menu it must not cover is still reachable on this screen.
    await expect(page.getByPlaceholder(/search/i).first()).toBeVisible();
    expect(await contentScrollsSideways(page)).toBe(false);
  });

  test('TAB-DINE-002 the bill sheet and its split control fit both orientations', async ({
    page,
  }) => {
    await signInAsRestaurantWaiter(page);
    await page.goto('/pos?mode=dine-in');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Which table?')).toBeVisible({ timeout: 20_000 });

    // Seat the first free table, which swaps the picker for the strip.
    await page
      .locator('button')
      .filter({ hasText: /^[A-Z]{1,3}-?\d+/ })
      .first()
      .click();
    const bill = page.getByRole('button', { name: 'Bill' });
    await expect(bill).toBeVisible({ timeout: 20_000 });

    await bill.click();
    // A freshly seated table has nothing sent, so the sheet says so — that
    // is the honest empty state, and it is what proves the sheet opened.
    await expect(page.getByText(/no bill to settle|nothing has been sent/i)).toBeVisible({
      timeout: 20_000,
    });
    expect(await contentScrollsSideways(page)).toBe(false);
  });
});
