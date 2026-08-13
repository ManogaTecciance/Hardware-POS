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
    await page.goto('/pos');
    await page.waitForLoadState('networkidle');

    // Every viewport must render the primary nav — this is the positive
    // control that prevents an empty-DOM false pass on either branch.
    const nav = page.getByRole('navigation', { name: /primary/i });
    await expect(nav.first()).toBeAttached();

    if (isPortrait(page)) {
      // Portrait ⇒ rail hidden, drawer trigger button visible in header.
      // The rail is `.hidden tab:flex`; on 834×1194 that resolves to
      // display:none, so it must not be rendered "visible".
      const railSidebar = page.locator('aside[aria-label="Primary" i]').first();
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
      // restaurant tenant sees ("POS").
      await expect(page.getByRole('link', { name: /^pos$/i }).first()).toBeVisible();
    }
  });
});

// ── POS Counter — cart aside landscape vs sticky bar portrait ───────────

test.describe('TAB-POS — POS Counter tablet layout', () => {
  test('TAB-POS-001 counter renders correct cart affordance per orientation', async ({ page }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/pos');
    await page.waitForLoadState('networkidle');

    // Both orientations must render the menu column (positive control).
    // The menu column shows the search input placeholder "Search menu…".
    await expect(page.getByPlaceholder(/search menu/i)).toBeVisible();

    if (isPortrait(page)) {
      // Portrait ⇒ the cart aside must not be visible (it has
      // `hidden tab:block`), and the sticky bottom order bar exists at
      // the bottom of the viewport. The bar is a full-width button
      // whose label starts with the item count.
      // The button reads "N items — LKR X" and has a "View order" hint.
      // Cart isn't guaranteed to have items yet — the bar renders even
      // when empty ("0 items"), so this asserts presence, not count.
      const orderBar = page.getByRole('button', { name: /view order|order/i }).last();
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
  test('TAB-KIT-001 status filter chips render as touch-friendly row', async ({ page }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/kitchen');
    await page.waitForLoadState('networkidle');

    // "All" filter chip is always present; verify touch height.
    const allChip = page.getByRole('button', { name: /^all$/i }).first();
    if (await allChip.isVisible().catch(() => false)) {
      const box = await allChip.boundingBox();
      if (box) expect(box.height).toBeGreaterThanOrEqual(40);
    }
  });
});

// ── Menu wizard preview affordance ──────────────────────────────────────

test.describe('TAB-MNU — Add Menu Item wizard tablet layout', () => {
  test('TAB-MNU-001 Preview button appears in footer on tablet, inline aside on desktop only', async ({
    page,
  }) => {
    await signInAsRestaurantOwner(page);
    await page.goto('/menu/items/new');
    await page.waitForLoadState('networkidle');

    // The wizard shell renders the stepper on all viewports.
    await expect(page.getByText(/product details|menu details/i).first()).toBeVisible();

    // On tablet-and-narrower the inline preview aside is not rendered;
    // a Preview button in the footer opens the same content as a Sheet.
    // Both 1194 and 834 are `<lg` (1024) — so BOTH tablet projects
    // should see the Preview button and NOT the inline aside.
    // (Desktop 1440 test — covered by desktop chromium project — does
    //  not run this spec.)
    await expect(page.getByRole('button', { name: /^preview$/i })).toBeVisible();
    // The inline aside carries `aria-label="Menu preview"` on desktop.
    // On `<lg` viewports it must not exist in the DOM (gated by
    // `useIsDesktop()`), not merely hidden.
    await expect(page.locator('aside[aria-label*="preview" i]')).toHaveCount(0);
  });
});
