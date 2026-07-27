import { test, expect } from '../src/fixtures';
import { AUTH } from '../src/fixtures';

test.describe('DASH / UI — browser', () => {
  test.use({ storageState: AUTH.owner });

  test('DASH-001 admin KPI band shows the five cards', async ({ page }) => {
    await page.goto('/dashboard');
    for (const label of ['Net Sales', 'Transactions', 'Total Inventory Value', 'Open Quotations']) {
      await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
    }
  });

  test('DASH-002 five KPI cards on one row at 1280 with sidebar expanded', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/dashboard');
    // Anchor on the KPI grid (the grid whose FIRST card is "Net Sales") and
    // measure only its direct children — labels like "Transactions" also appear
    // in lower section cards, so a page-wide hasText match is ambiguous.
    const kpiCard = page.locator('main div.dash-enter', { hasText: 'Net Sales' }).first();
    await kpiCard.waitFor();
    // Wait for the KPI grid to settle at its full 5 cells before measuring —
    // an early read can catch a transitional render with fewer cards.
    await page.waitForFunction(() => {
      const card = Array.from(document.querySelectorAll('main div.dash-enter')).find((d) =>
        d.textContent?.includes('Net Sales'),
      );
      return card?.parentElement?.children.length === 5;
    });
    const result = await kpiCard.evaluate((card) => {
      const grid = card.parentElement!;
      const cells = Array.from(grid.children) as HTMLElement[];
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
      // offsetTop reflects LAYOUT position (grid row), unaffected by the
      // staggered `dash-enter` entrance transform that skews getBoundingClientRect.
      const rows = new Set(cells.map((c) => c.offsetTop)).size;
      return { count: cells.length, cols, rows };
    });
    expect(result.count).toBe(5);
    expect(result.cols).toBe(5);
    expect(result.rows).toBe(1);
  });

  test('DASH-004 millions render compactly on inventory card', async ({ page }) => {
    await page.goto('/dashboard');
    const card = page.locator('main div.dash-enter', { hasText: 'Total Inventory Value' }).first();
    await expect(card).toContainText(/mil|Rs\./);
  });

  test('DASH-007 inventory card deep-links to products', async ({ page }) => {
    await page.goto('/dashboard');
    await page.locator('main div.dash-enter', { hasText: 'Total Inventory Value' }).first().click();
    await page.waitForURL(/\/products/);
  });

  test('DASH-015 no branch/register chips in header', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('banner')).not.toContainText('Main Branch');
    await expect(page.getByRole('banner')).not.toContainText('Register 1');
  });

  test('UI-001 dark mode re-themes the page body', async ({ page }) => {
    await page.goto('/dashboard');
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await page.waitForTimeout(200);
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(dark).not.toBe(light);
  });

  test('UI-013 command palette opens with Ctrl+K', async ({ page }) => {
    await page.goto('/dashboard');
    await page.keyboard.press('Control+k');
    await expect(page.getByPlaceholder(/search/i).first()).toBeVisible();
  });

  test('UI-007 dashboard has no horizontal overflow at 1280', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/dashboard');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);
  });
});

test.describe('QUO — builder UI', () => {
  test.use({ storageState: AUTH.owner });

  test('QUO-006 quotation builder has no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/quotations/new');
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);
  });
});

test.describe('SUP / CUST — list pages render', () => {
  test.use({ storageState: AUTH.owner });

  test('SUP-UI suppliers page shows Import + Add', async ({ page }) => {
    await page.goto('/suppliers');
    await expect(page.getByRole('button', { name: 'Import' })).toBeVisible();
    await expect(page.getByRole('link', { name: /add vendor/i })).toBeVisible();
  });

  test('CUST-UI customers page shows Import + Add', async ({ page }) => {
    await page.goto('/customers');
    await expect(page.getByRole('button', { name: 'Import' })).toBeVisible();
    await expect(page.getByRole('link', { name: /add customer/i })).toBeVisible();
  });

  test('QB-UI QuickBooks overview shows five sync cards', async ({ page }) => {
    await page.goto('/quickbooks');
    for (const label of ['Product sync', 'Customer sync', 'Vendor sync', 'Sales sync', 'Sync errors']) {
      await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
    }
  });
});
