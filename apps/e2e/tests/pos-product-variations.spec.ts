/**
 * POS-VAR — Restaurant Product Variations inside the POS Customise dialog
 * (D46 Phase 4, UI-level).
 *
 * The D46 slice added Product Variations to the runtime POS: when a Product
 * carries active variants, the Customise dialog renders a single-select
 * radiogroup ABOVE the modifier groups, gates Add-to-Cart until a variant is
 * picked (or an isDefault preselect exists), and threads the picked
 * `productVariantId` all the way through the cart → round submit → Sale +
 * KOT ticket. This spec exercises the four UI beats that make the feature
 * feel like one journey — dialog exposure, single-select semantics,
 * add-to-cart with modifiers + notes, and the Edit round-trip that must
 * preserve then update the picked variant + modifiers.
 *
 * Fixture strategy (`beforeAll`):
 *   ── Restaurant tenant only. The seed data ships Mix Kottu / Chicken Kottu
 *      as legacy MenuItems (Phase 3 fixture); Product-side variations are a
 *      Phase 4 feature and are NOT in the pilot seed, so the spec creates
 *      its own POS-sellable Restaurant Product ("Mix Fried Rice <RUN_ID>")
 *      with three size variants and one Extras modifier group.
 *   ── Every name / SKU carries RUN_ID so re-runs on a shared dev box never
 *      collide with themselves or with the D45 spec's `RPW Mix Kottu` seed.
 *   ── Verified via `GET /restaurant/pos-catalogue` before the UI cases run
 *      — a missing catalogue row is a real failure (not test flake), and
 *      the beforeAll must surface it loudly rather than skip.
 *
 * Scope call: POS-VAR-005 (backend cross-product variant guard) is left as
 * `test.skip` and links to the integration spec that covers it end-to-end,
 * because opening a table session + order via HTTP would balloon this file's
 * setup past the >100 LOC threshold called out in the D46 brief.
 */
import { expect, test } from '@playwright/test';

import { API_URL, Api, apiLogin, RESTAURANT_SEED, RUN_ID } from '../src/api';

// ── Fixture ──────────────────────────────────────────────────────────────

interface FixtureIds {
  productId: string;
  productName: string;
  variantIds: { small: string; medium: string; large: string };
  extrasGroupId: string;
  optionIds: { chicken: string; cheese: string; egg: string };
}

/**
 * Populated once per file. Every UI case reads `fixture.productName` for its
 * item-picker and asserts against `fixture.variantIds` / `fixture.optionIds`
 * when it needs to disambiguate against another run's leftovers.
 */
let fixture: FixtureIds;

/**
 * `PUT /products/:productId/variations` — the batch's dimension source. The
 * `Api` wrapper doesn't expose PUT (its factory list stops at POST/PATCH), so
 * this helper drops to `api.ctx.put` the same way `product-variants.spec.ts`
 * does. Returns typed dimensions + option ids for the batch payload below.
 */
async function putVariations(
  api: Api,
  productId: string,
  dimensions: Array<{
    name: string;
    position: number;
    options: Array<{ name: string; position: number }>;
  }>,
): Promise<{
  dimensions: Array<{
    id: string;
    name: string;
    options: Array<{ id: string; name: string }>;
  }>;
}> {
  const res = await api.ctx.put(`${API_URL}/products/${productId}/variations`, {
    data: { dimensions },
  });
  expect(res.ok(), `PUT /products/${productId}/variations → ${res.status()}`).toBeTruthy();
  return ((await res.json()) as {
    data: {
      dimensions: Array<{
        id: string;
        name: string;
        options: Array<{ id: string; name: string }>;
      }>;
    };
  }).data;
}

/**
 * `PUT /products/:productId/modifier-groups` — attach a modifier group to a
 * product. Same PUT-not-in-wrapper reason as `putVariations`.
 */
async function putProductModifierGroups(
  api: Api,
  productId: string,
  modifierGroupIds: string[],
): Promise<void> {
  const res = await api.ctx.put(`${API_URL}/products/${productId}/modifier-groups`, {
    data: { modifierGroupIds },
  });
  expect(
    res.ok(),
    `PUT /products/${productId}/modifier-groups → ${res.status()}`,
  ).toBeTruthy();
}

test.beforeAll(async () => {
  const auth = await apiLogin(
    RESTAURANT_SEED.owner.email,
    RESTAURANT_SEED.owner.password,
    RESTAURANT_SEED.workspace,
  );
  const api = await Api.create(auth);

  const productName = `Mix Fried Rice ${RUN_ID}`;

  // A POS-sellable Restaurant Product. `unitPrice: 0` because the three size
  // variants below carry the real prices — the parent's price is unused when
  // `hasVariants=true` (`pos-catalogue.service.ts` L172 flips it to null in
  // the response). `foodType: 'FOOD'` is required so the catalogue adapter
  // buckets the item into the "Food" section chip the UI cases search under.
  const product = await api.post<{ id: string }>('/products', {
    name: productName,
    type: 'Inventory',
    unitPrice: 0,
    foodType: 'FOOD',
  });

  // One Size dimension with three options — the wizard's canonical shape for
  // Small/Medium/Large. `position` seeds the sort order so the runtime radios
  // render Small → Medium → Large regardless of insertion sequence.
  const variations = await putVariations(api, product.id, [
    {
      name: 'Size',
      position: 0,
      options: [
        { name: 'Small', position: 0 },
        { name: 'Medium', position: 1 },
        { name: 'Large', position: 2 },
      ],
    },
  ]);
  const sizeDim = variations.dimensions[0]!;
  const optId = (name: string): string =>
    sizeDim.options.find((o) => o.name === name)!.id;

  // D46 hotfix — the batch DTO now accepts `isDefault`. Medium seeded as the
  // default so the POS Customise dialog preselects it on open. POS-VAR-001
  // asserts that preselect.
  const batchRes = await api.postRaw(`/products/${product.id}/variants:batch`, {
    variants: [
      {
        sku: `RICE-S-${RUN_ID}`,
        unitPrice: 990,
        isActive: true,
        position: 0,
        optionValues: [{ dimensionId: sizeDim.id, optionId: optId('Small') }],
      },
      {
        sku: `RICE-M-${RUN_ID}`,
        unitPrice: 1290,
        isActive: true,
        isDefault: true,
        position: 1,
        optionValues: [{ dimensionId: sizeDim.id, optionId: optId('Medium') }],
      },
      {
        sku: `RICE-L-${RUN_ID}`,
        unitPrice: 1890,
        isActive: true,
        position: 2,
        optionValues: [{ dimensionId: sizeDim.id, optionId: optId('Large') }],
      },
    ],
  });
  expect(
    batchRes.ok(),
    `POST /products/${product.id}/variants:batch → ${batchRes.status()} ${await batchRes.text().catch(() => '')}`,
  ).toBeTruthy();
  const batch = ((await batchRes.json()) as { data: Array<{ id: string; sku: string }> }).data;
  const bySku = new Map(batch.map((v) => [v.sku, v.id] as const));

  // Extras modifier group — plain Multiple-select group (not role SIZE, which
  // is reserved by the wizard for its variant emulation). Prices in raw
  // currency units so the item-total math in POS-VAR-003 lines up cleanly.
  const extrasGroup = await api.post<{
    id: string;
    options: Array<{ id: string; name: string }>;
  }>('/restaurant/modifier-groups', {
    name: `Extras ${RUN_ID}`,
    selection: 'MULTIPLE',
    minSelections: 0,
    maxSelections: 4,
    options: [
      { name: 'Extra Chicken', priceDelta: 300, position: 0 },
      { name: 'Extra Cheese', priceDelta: 200, position: 1 },
      { name: 'Egg', priceDelta: 100, position: 2 },
    ],
  });
  const optByName = new Map(extrasGroup.options.map((o) => [o.name, o.id] as const));

  await putProductModifierGroups(api, product.id, [extrasGroup.id]);

  // Verify the catalogue surface — a missing product here is a hard failure,
  // not a skip: the UI cases below cannot render what the API refuses to
  // return, and pretending otherwise would hide a real Phase 4 regression.
  const catalogue = await api.get<{
    items: Array<{
      id: string;
      variants: Array<{ id: string; isActive: boolean }>;
      modifierGroups: Array<{ id: string }>;
    }>;
  }>(`/restaurant/pos-catalogue?branchId=${RESTAURANT_SEED.branchId}&foodType=FOOD`);
  const seededRow = catalogue.items.find((it) => it.id === product.id);
  expect(seededRow, `seeded product must appear in POS catalogue for branch ${RESTAURANT_SEED.branchId}`).toBeDefined();
  expect(seededRow!.variants.filter((v) => v.isActive)).toHaveLength(3);
  expect(seededRow!.modifierGroups.some((g) => g.id === extrasGroup.id)).toBeTruthy();

  fixture = {
    productId: product.id,
    productName,
    variantIds: {
      small: bySku.get(`RICE-S-${RUN_ID}`)!,
      medium: bySku.get(`RICE-M-${RUN_ID}`)!,
      large: bySku.get(`RICE-L-${RUN_ID}`)!,
    },
    extrasGroupId: extrasGroup.id,
    optionIds: {
      chicken: optByName.get('Extra Chicken')!,
      cheese: optByName.get('Extra Cheese')!,
      egg: optByName.get('Egg')!,
    },
  };

  await api.ctx.dispose();
});

// ── UI helpers ───────────────────────────────────────────────────────────

/**
 * Same sign-in dance the pos-counter spec uses — a real form login, so the
 * `/pos` shell renders from a live platform-profile resolve rather than a
 * fixture that could drift from the shipped shape.
 */
async function signInAsRestaurantOwner(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.locator('#workspace').fill(RESTAURANT_SEED.workspace);
  await page.locator('#email').fill(RESTAURANT_SEED.owner.email);
  await page.locator('#password').fill(RESTAURANT_SEED.owner.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
}

/**
 * Land on the POS composition screen for a specific mode, skipping the Order
 * Type modal. Takeaway is used across every case because the catalogue is
 * shared across modes for Restaurant tenants — only the channel-scoped
 * promotions differ (none apply to this fixture).
 */
async function gotoPosTakeaway(page: import('@playwright/test').Page) {
  await page.goto('/pos?mode=takeaway');
  // Anchor: the Change chip is the compact-mode affordance that only appears
  // once the workspace has committed to a mode. Waiting on it beats a naked
  // `waitForLoadState` because it survives skeleton flashes.
  await expect(page.getByRole('button', { name: /change/i })).toBeVisible();
}

/**
 * Search-based item picker — mirrors the pos-counter helper for the same
 * reason: the widened search hits every foodType bucket, so a chip-default
 * change in the shell cannot break the test. Uses the fixture product name
 * so the RUN_ID prevents collisions with prior seeds.
 */
async function pickFixtureProduct(page: import('@playwright/test').Page) {
  const search = page.getByPlaceholder(/search menu/i);
  await search.fill('');
  // First distinctive word is unique enough — the product carries RUN_ID.
  await search.type('Mix', { delay: 20 });
  const card = page.getByRole('button', { name: new RegExp(fixture.productName, 'i') }).first();
  await card.waitFor({ state: 'visible', timeout: 5_000 });
  await card.click();
  await search.fill('');
}

/**
 * The Customise sheet's `role="dialog"` filtered to the fixture item so we
 * never accidentally interact with the Order Type modal or a later payment
 * dialog. Title format is `Customise: ${item.name}`.
 */
function customiseDialog(page: import('@playwright/test').Page) {
  return page
    .getByRole('dialog')
    .filter({ hasText: new RegExp(`customise:.*${fixture.productName}`, 'i') });
}

// ── Cases ────────────────────────────────────────────────────────────────

test.describe('POS-VAR — Product Variations in Customise', () => {
  test('POS-VAR-001 Product with Small/Medium/Large exposes all active variants in POS', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await signInAsRestaurantOwner(page);
    await gotoPosTakeaway(page);
    await pickFixtureProduct(page);

    const dialog = customiseDialog(page);
    await expect(dialog).toBeVisible();

    // The SIZE radiogroup renders above modifier groups whenever the item
    // carries active variants. Its accessible name is 'SIZE' (see
    // `modifier-picker-dialog.tsx` `VariantSection`); the /size|customise/i
    // regex is tolerant of a future rename that promotes the dimension name
    // instead of the placeholder.
    const rg = dialog.getByRole('radiogroup', { name: /size|customise/i });
    await expect(rg).toBeVisible();

    // Exactly three radios — Small / Medium / Large — in position order.
    const radios = rg.getByRole('radio');
    await expect(radios).toHaveCount(3);
    const smallRadio = rg.getByRole('radio', { name: /small/i });
    const mediumRadio = rg.getByRole('radio', { name: /medium/i });
    const largeRadio = rg.getByRole('radio', { name: /large/i });
    await expect(smallRadio).toBeVisible();
    await expect(mediumRadio).toBeVisible();
    await expect(largeRadio).toBeVisible();

    // D46 default preselect. The seed marked Medium as `isDefault=true`;
    // the Customise dialog must open with Medium already checked and
    // Small/Large unchecked (single-select semantics). This is the
    // observable half of what `customise-dialog.render.test.tsx` D3
    // pins at the unit level.
    await expect(mediumRadio).toHaveAttribute('aria-checked', 'true');
    await expect(smallRadio).toHaveAttribute('aria-checked', 'false');
    await expect(largeRadio).toHaveAttribute('aria-checked', 'false');

    // Touch target — every radio row is `min-h-11` (44px) per the counter
    // POS coarse-pointer spec. A boundingBox() check on each row proves the
    // Tailwind class was applied rather than trusting the class name alone.
    for (const radio of [smallRadio, mediumRadio, largeRadio]) {
      const box = await radio.boundingBox();
      expect(box, 'each variant row has layout dimensions').not.toBeNull();
      expect(box!.height, 'variant row height ≥ 44px (coarse-pointer target)').toBeGreaterThanOrEqual(44);
    }

    // Price on every row. The row text carries `LKR <n,nnn>.00` from
    // `formatMoney(v.unitPrice)`; we allow either "990.00" or "990" so a
    // future format tweak doesn't break the assertion, but the LKR prefix
    // is non-negotiable — that is the tenant currency and must render.
    await expect(smallRadio).toContainText(/LKR\s*990/);
    await expect(mediumRadio).toContainText(/LKR\s*1,?290/);
    await expect(largeRadio).toContainText(/LKR\s*1,?890/);
  });

  test('POS-VAR-002 single-select semantics — only one variant checked at a time', async ({ page }) => {
    test.setTimeout(60_000);

    await signInAsRestaurantOwner(page);
    await gotoPosTakeaway(page);
    await pickFixtureProduct(page);

    const dialog = customiseDialog(page);
    const rg = dialog.getByRole('radiogroup', { name: /size|customise/i });
    const smallRadio = rg.getByRole('radio', { name: /small/i });
    const mediumRadio = rg.getByRole('radio', { name: /medium/i });
    const largeRadio = rg.getByRole('radio', { name: /large/i });

    // Click Large → Large becomes checked; Medium/Small stay unchecked.
    await largeRadio.click();
    await expect(largeRadio).toHaveAttribute('aria-checked', 'true');
    await expect(mediumRadio).toHaveAttribute('aria-checked', 'false');
    await expect(smallRadio).toHaveAttribute('aria-checked', 'false');

    // Click Medium → Medium becomes checked; Large flips off (single-select).
    await mediumRadio.click();
    await expect(mediumRadio).toHaveAttribute('aria-checked', 'true');
    await expect(largeRadio).toHaveAttribute('aria-checked', 'false');
    await expect(smallRadio).toHaveAttribute('aria-checked', 'false');

    // Cross-check: at most one aria-checked="true" across the whole group.
    // Prevents a regression where a shared name attribute stops enforcing
    // single-select and two radios latch simultaneously.
    const checkedCount = await rg.getByRole('radio', { checked: true }).count();
    expect(checkedCount, 'exactly one variant radio is checked').toBe(1);
  });

  test('POS-VAR-003 add-to-cart golden path — variant + modifiers + note flow through', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await signInAsRestaurantOwner(page);
    await gotoPosTakeaway(page);
    await pickFixtureProduct(page);

    const dialog = customiseDialog(page);
    // Pick Large (unitPrice 1890).
    await dialog.getByRole('radio', { name: /large/i }).click();

    // Two modifier checkboxes — Extra Chicken (+300) and Extra Cheese (+200).
    // The dialog nests each option inside a <label>; the checkbox itself
    // carries the accessible name from that label.
    await dialog.getByRole('checkbox', { name: /extra chicken/i }).check();
    await dialog.getByRole('checkbox', { name: /extra cheese/i }).check();

    // Special instructions — a plain <input> keyed by the "Special instructions"
    // label. The dialog wires it through `#modifier-instructions`.
    await dialog.getByLabel(/special instructions/i).fill('No onion');

    // Quantity stays at 1 (the default). Live item total = 1890 + 300 + 200
    // = 2390. Format is `LKR 2,390.00`; regex is lenient about separator
    // presence per the D46 brief.
    await expect(dialog).toContainText(/LKR\s*2,?390(\.00)?/);

    // Commit — "Add to Cart" (non-edit label; edit mode reads "Update item").
    await dialog.getByRole('button', { name: /add to cart/i }).click();
    await expect(dialog).toBeHidden();

    // The cart line renders the fixture product's name as the primary
    // sub-line. Scope to the cart aside so we don't match the menu card.
    const cartLine = page
      .locator('div.rounded-lg.border', {
        has: page.getByText(fixture.productName, { exact: true }),
      })
      .first();
    await expect(cartLine).toBeVisible();

    // The variant name appears as its own sub-line (D46 requirement —
    // Small vs Large is often the only visible difference between two
    // orders of the same Product).
    await expect(cartLine).toContainText(/Large/);

    // Modifiers render as `+ Extra Chicken` / `+ Extra Cheese` list items.
    // The `+ ` prefix is the pos-cart formatting for modifier sub-lines.
    await expect(cartLine).toContainText(/\+\s*Extra Chicken/);
    await expect(cartLine).toContainText(/\+\s*Extra Cheese/);

    // Special-instructions note. The cart wraps it in "Note: <text>".
    await expect(cartLine).toContainText(/Note:\s*No onion/);

    // The line total reflects the same 2,390 the dialog previewed. Kept
    // tolerant of thousand-separator changes; the LKR prefix stays.
    await expect(cartLine).toContainText(/LKR\s*2,?390(\.00)?/);
  });

  test('POS-VAR-004 Edit restores selections and Update Item persists changes', async ({ page }) => {
    test.setTimeout(60_000);

    await signInAsRestaurantOwner(page);
    await gotoPosTakeaway(page);
    await pickFixtureProduct(page);

    // Seed the same Add-to-Cart state POS-VAR-003 produced. Cases run in
    // isolation (Playwright resets browser state between tests), so this
    // spec re-drives the flow rather than depending on POS-VAR-003 order.
    const initialDialog = customiseDialog(page);
    await initialDialog.getByRole('radio', { name: /large/i }).click();
    await initialDialog.getByRole('checkbox', { name: /extra chicken/i }).check();
    await initialDialog.getByRole('checkbox', { name: /extra cheese/i }).check();
    await initialDialog.getByLabel(/special instructions/i).fill('No onion');
    await initialDialog.getByRole('button', { name: /add to cart/i }).click();
    await expect(initialDialog).toBeHidden();

    // Re-open via the cart line's Edit button.
    const cartLine = page
      .locator('div.rounded-lg.border', {
        has: page.getByText(fixture.productName, { exact: true }),
      })
      .first();
    await cartLine.getByRole('button', { name: /^edit$/i }).click();

    const editDialog = customiseDialog(page);
    await expect(editDialog).toBeVisible();

    // Edit-mode hydration: the previously-picked Large radio is checked,
    // both modifiers are ticked, the note is preserved, and the primary
    // action label swaps to "Update item" (see `modifier-picker-dialog.tsx`
    // L282 — `initialLine ? 'Update item' : 'Add to Cart'`).
    const rg = editDialog.getByRole('radiogroup', { name: /size|customise/i });
    await expect(rg.getByRole('radio', { name: /large/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(editDialog.getByRole('checkbox', { name: /extra chicken/i })).toBeChecked();
    await expect(editDialog.getByRole('checkbox', { name: /extra cheese/i })).toBeChecked();
    await expect(editDialog.getByLabel(/special instructions/i)).toHaveValue('No onion');
    await expect(editDialog.getByRole('button', { name: /update item/i })).toBeVisible();
    await expect(editDialog.getByRole('button', { name: /^add to cart$/i })).toHaveCount(0);

    // Change Large → Medium, uncheck Extra Cheese, and commit.
    await rg.getByRole('radio', { name: /medium/i }).click();
    await editDialog.getByRole('checkbox', { name: /extra cheese/i }).uncheck();
    await editDialog.getByRole('button', { name: /update item/i }).click();
    await expect(editDialog).toBeHidden();

    // The cart line now reads Medium, drops Extra Cheese, and totals
    // 1290 + 300 = 1590.
    await expect(cartLine).toContainText(/Medium/);
    await expect(cartLine).toContainText(/\+\s*Extra Chicken/);
    await expect(cartLine).not.toContainText(/Extra Cheese/);
    await expect(cartLine).toContainText(/LKR\s*1,?590(\.00)?/);
  });

  // POS-VAR-005 — API-level cross-product variant guard. Left as a
  // documented skip because opening a table session + order via HTTP so
  // the round-item POST has a target adds >100 LOC of setup that is not
  // load-bearing for the D46 UI journey. The `VariantNotOnProductError`
  // path is exercised end-to-end in the API integration spec
  // `apps/api/test/integration/specs/table-sessions-submit-round-d46.spec.ts`,
  // which already builds the two-product / cross-variant scenario.
  test.skip('POS-VAR-005 backend cross-product variant guard is covered by integration spec', () => {
    // No-op: see the comment above.
  });
});
