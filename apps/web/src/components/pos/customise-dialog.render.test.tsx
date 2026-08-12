/**
 * Customise dialog — D46 product variations + modifiers.
 *
 * Load-bearing rules from the D46 Phase 4 brief:
 *   * A Product with variants renders a single-select radiogroup ABOVE the
 *     modifier groups. Variants are single-select; modifiers stay
 *     multi-select. One cannot infer the other.
 *   * Default variant preselect; otherwise Add-to-Cart is disabled and a
 *     hint appears only AFTER the operator has interacted.
 *   * Inactive variants render disabled + "Unavailable" and cannot be
 *     picked. `aria-disabled="true"` so ATs skip them.
 *   * Live total = (variantPrice ?? basePrice) + Σ modifier deltas ×
 *     quantity. NEVER basePrice + variantPrice — that is the D46
 *     anti-pattern; the assertion below fails loudly if a refactor
 *     reintroduces it.
 *   * Edit-mode hydration pre-populates the picked variant, modifiers,
 *     quantity and notes; primary action reads "Update item".
 *   * A Product without variants renders NO SIZE section (silent
 *     regression today would be a needless first tap on every legacy
 *     item, which is unacceptable UX).
 *
 * Every negative assertion is paired with a positive control per the
 * architectural-test integrity rule (D30) so a component that always /
 * never rendered the section would fail rather than pass silently.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  MenuItemVariantView,
  MenuItemView,
  ModifierGroupView,
} from '@/lib/restaurant/types';

import { ModifierPickerDialog } from './modifier-picker-dialog';
import type { DraftLine } from './pos-types';

afterEach(cleanup);

// ── Fixtures ──────────────────────────────────────────────────────────────

function variant(
  overrides: Partial<MenuItemVariantView> & { id: string; name: string; unitPrice: number },
): MenuItemVariantView {
  return {
    sku: `sku_${overrides.id}`,
    isDefault: false,
    isActive: true,
    ...overrides,
  };
}

function productItem(overrides: Partial<MenuItemView> = {}): MenuItemView {
  return {
    id: 'prod_mix_fried_rice',
    sectionId: '__section_food__',
    name: 'Mix Fried Rice',
    description: null,
    basePrice: '1000',
    productId: 'prod_mix_fried_rice',
    isActive: true,
    position: 0,
    modifierGroupIds: [],
    stationIds: [],
    channelPrices: [],
    availability: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    itemType: 'FOOD',
    prepMinutes: 15,
    dietaryTags: [],
    imageUrl: null,
    catalogueSource: 'PRODUCT',
    variants: [],
    ...overrides,
  };
}

function legacyMenuItem(overrides: Partial<MenuItemView> = {}): MenuItemView {
  return {
    id: 'mit_kottu',
    sectionId: 'sec_kottu',
    name: 'Kottu',
    description: null,
    basePrice: '800',
    productId: null,
    isActive: true,
    position: 0,
    modifierGroupIds: [],
    stationIds: [],
    channelPrices: [],
    availability: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    itemType: 'FOOD',
    prepMinutes: 10,
    dietaryTags: [],
    imageUrl: null,
    // Legacy path — no catalogueSource, no variants.
    ...overrides,
  };
}

const NO_GROUPS = new Map<string, ModifierGroupView>();

// ── D1: no variants ⇒ no SIZE section ────────────────────────────────────

describe('Customise dialog — variants', () => {
  it('D1: Product without variants renders no SIZE section (fast path unchanged)', () => {
    render(
      <ModifierPickerDialog
        item={productItem({ variants: [] })}
        groupsById={NO_GROUPS}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    // Negative: no radiogroup element at all.
    expect(screen.queryByRole('radiogroup')).toBeNull();
    // Positive control: the dialog itself did render — the Sheet exposes
    // one role="dialog". This proves the negative above is not a false
    // pass from the whole tree failing to render.
    expect(screen.getByRole('dialog')).toBeDefined();
    // And Add to Cart is not aria-disabled (no variant to gate on).
    expect(
      screen.getByRole('button', { name: /add to cart/i }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  // ── D2: 3 variants ⇒ radiogroup with 3 options; single-select ─────────

  it('D2: renders a radiogroup with one radio per active variant', () => {
    const item = productItem({
      variants: [
        variant({ id: 'v_s', name: 'Small', unitPrice: 990 }),
        variant({ id: 'v_m', name: 'Medium', unitPrice: 1290, isDefault: true }),
        variant({ id: 'v_l', name: 'Large', unitPrice: 1590 }),
      ],
    });
    render(
      <ModifierPickerDialog
        item={item}
        groupsById={NO_GROUPS}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const rg = screen.getByRole('radiogroup');
    const radios = within(rg).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    // Positive control: labels are legible and prices are on the row.
    expect(rg.textContent).toMatch(/Small/);
    expect(rg.textContent).toMatch(/Medium/);
    expect(rg.textContent).toMatch(/Large/);
    expect(rg.textContent).toMatch(/1,290/);
  });

  // ── D3: default variant preselected on open ────────────────────────────

  it('D3: variant marked isDefault=true is pre-selected on open', () => {
    const item = productItem({
      variants: [
        variant({ id: 'v_s', name: 'Small', unitPrice: 990 }),
        variant({ id: 'v_m', name: 'Medium', unitPrice: 1290, isDefault: true }),
        variant({ id: 'v_l', name: 'Large', unitPrice: 1590 }),
      ],
    });
    render(
      <ModifierPickerDialog
        item={item}
        groupsById={NO_GROUPS}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const rg = screen.getByRole('radiogroup');
    const radios = within(rg).getAllByRole('radio');
    // Exactly one aria-checked=true; the other two are false.
    const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    // The Medium radio (the default) is the one that carries it.
    expect(checked[0]?.textContent).toMatch(/Medium/);
    // Add to Cart is enabled straight away.
    expect(
      screen.getByRole('button', { name: /add to cart/i }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  // ── D4: no default ⇒ CTA disabled + dirty-gated hint ───────────────────

  it('D4: without a default, Add to Cart is disabled and the size hint appears only after interaction', () => {
    const item = productItem({
      variants: [
        variant({ id: 'v_s', name: 'Small', unitPrice: 990 }),
        variant({ id: 'v_l', name: 'Large', unitPrice: 1590 }),
      ],
    });
    render(
      <ModifierPickerDialog
        item={item}
        groupsById={NO_GROUPS}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const cta = screen.getByRole('button', { name: /add to cart/i });
    // The button is aria-disabled (semantic) rather than HTML-disabled so
    // the click still fires the "select a size" error path — a hard
    // disabled would swallow the tap and the dirty flag would never trip.
    expect(cta.getAttribute('aria-disabled')).toBe('true');
    // Before any interaction, the hint is silent.
    expect(document.body.textContent).not.toMatch(/select a size to continue/i);
    // Trying to submit surfaces the hint (interaction: click CTA counts).
    fireEvent.click(cta);
    expect(document.body.textContent).toMatch(/select a size to continue/i);
    // Positive control: picking a variant clears the aria-disabled state.
    const large = within(screen.getByRole('radiogroup')).getByRole('radio', { name: /large/i });
    fireEvent.click(large);
    expect(cta.getAttribute('aria-disabled')).toBeNull();
  });

  // ── D5: inactive variant ⇒ aria-disabled + Unavailable + not tappable ─

  it('D5: inactive variant renders aria-disabled + Unavailable chip and cannot be selected', () => {
    const item = productItem({
      variants: [
        variant({ id: 'v_s', name: 'Small', unitPrice: 990, isDefault: true }),
        variant({ id: 'v_l', name: 'Large', unitPrice: 1590, isActive: false }),
      ],
    });
    render(
      <ModifierPickerDialog
        item={item}
        groupsById={NO_GROUPS}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const rg = screen.getByRole('radiogroup');
    const large = within(rg).getByRole('radio', { name: /large/i });
    expect(large.getAttribute('aria-disabled')).toBe('true');
    expect((large as HTMLButtonElement).disabled).toBe(true);
    expect(large.getAttribute('tabindex')).toBe('-1');
    expect(within(rg).getByText(/unavailable/i)).toBeDefined();
    // Tapping does not select it — Small stays the checked radio.
    fireEvent.click(large);
    const checked = within(rg).getAllByRole('radio').filter(
      (r) => r.getAttribute('aria-checked') === 'true',
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]?.textContent).toMatch(/Small/);
  });

  // ── D6: variant single-select — Large deselects Medium ─────────────────

  it('D6: selecting Large deselects Medium (single-select semantics)', () => {
    const item = productItem({
      variants: [
        variant({ id: 'v_s', name: 'Small', unitPrice: 990 }),
        variant({ id: 'v_m', name: 'Medium', unitPrice: 1290, isDefault: true }),
        variant({ id: 'v_l', name: 'Large', unitPrice: 1590 }),
      ],
    });
    render(
      <ModifierPickerDialog
        item={item}
        groupsById={NO_GROUPS}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const rg = screen.getByRole('radiogroup');
    // Sanity: Medium is preselected.
    expect(
      within(rg).getByRole('radio', { name: /medium/i }).getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(within(rg).getByRole('radio', { name: /large/i }));
    // Exactly one aria-checked=true, and it's Large.
    const checked = within(rg).getAllByRole('radio').filter(
      (r) => r.getAttribute('aria-checked') === 'true',
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]?.textContent).toMatch(/Large/);
  });

  // ── D7: modifiers stack (multi-select unchanged) ───────────────────────

  it('D7: selecting an additional modifier stacks (multi-select semantics preserved)', () => {
    const extras: ModifierGroupView = {
      id: 'grp_extras',
      name: 'Extras',
      selection: 'MULTIPLE',
      minSelections: 0,
      maxSelections: 3,
      isActive: true,
      role: null,
      options: [
        { id: 'opt_cheese', name: 'Cheese', priceDelta: '200', position: 0, isActive: true },
        { id: 'opt_chicken', name: 'Chicken', priceDelta: '300', position: 1, isActive: true },
      ],
    };
    const item = productItem({ modifierGroupIds: ['grp_extras'] });
    const onConfirm = vi.fn();
    render(
      <ModifierPickerDialog
        item={item}
        groupsById={new Map([[extras.id, extras]])}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );
    // No variants — no radiogroup gating the CTA.
    fireEvent.click(screen.getByRole('checkbox', { name: /Cheese/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Chicken/ }));
    fireEvent.click(screen.getByRole('button', { name: /add to cart/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const line = (onConfirm.mock.calls[0]?.[0] as DraftLine[])[0]!;
    expect(line.modifiers.map((m) => m.optionName).sort()).toEqual(['Cheese', 'Chicken']);
  });

  // ── D8: live total math + D46 anti-pattern guard ───────────────────────

  it('D8: live total = variant absolute price + modifier deltas × quantity (variant NOT stacked on basePrice)', () => {
    // Deliberately pick numbers where the anti-pattern would be visible:
    //   basePrice 1000, Medium variant 1290, +200 modifier, qty 2.
    //   Correct: (1290 + 200) * 2 = 2980.
    //   Anti-pattern (base + variant): (1000 + 1290 + 200) * 2 = 4980.
    const extras: ModifierGroupView = {
      id: 'grp_extras',
      name: 'Extras',
      selection: 'MULTIPLE',
      minSelections: 0,
      maxSelections: 3,
      isActive: true,
      role: null,
      options: [
        { id: 'opt_cheese', name: 'Cheese', priceDelta: '200', position: 0, isActive: true },
      ],
    };
    const item = productItem({
      basePrice: '1000',
      modifierGroupIds: ['grp_extras'],
      variants: [
        variant({ id: 'v_m', name: 'Medium', unitPrice: 1290, isDefault: true }),
      ],
    });
    render(
      <ModifierPickerDialog
        item={item}
        groupsById={new Map([[extras.id, extras]])}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /Cheese/ }));
    // Bump qty from 1 → 2.
    fireEvent.click(screen.getByLabelText('Increase quantity'));
    // Correct total shows.
    expect(document.body.textContent).toMatch(/2,980/);
    // Anti-pattern total (would be 4,980) must not appear anywhere.
    expect(document.body.textContent).not.toMatch(/4,980/);
  });

  // ── D9: edit-mode hydration ────────────────────────────────────────────

  it('D9: edit-mode hydrates variant + modifiers + notes + qty and primary action reads Update item', () => {
    const extras: ModifierGroupView = {
      id: 'grp_extras',
      name: 'Extras',
      selection: 'MULTIPLE',
      minSelections: 0,
      maxSelections: 3,
      isActive: true,
      role: null,
      options: [
        { id: 'opt_cheese', name: 'Cheese', priceDelta: '200', position: 0, isActive: true },
        { id: 'opt_chicken', name: 'Chicken', priceDelta: '300', position: 1, isActive: true },
      ],
    };
    const item = productItem({
      modifierGroupIds: ['grp_extras'],
      variants: [
        variant({ id: 'v_s', name: 'Small', unitPrice: 990 }),
        variant({ id: 'v_l', name: 'Large', unitPrice: 1590, isDefault: true }),
      ],
    });
    const initial: DraftLine = {
      key: 'k_existing',
      menuItemId: item.id,
      name: item.name,
      unitPrice: '990',
      quantity: 3,
      specialInstructions: 'no coriander',
      modifiers: [
        {
          optionId: 'opt_chicken',
          optionName: 'Chicken',
          groupName: 'Extras',
          priceDelta: '300',
        },
      ],
      sourceKind: 'PRODUCT',
      productId: item.id,
      productVariantId: 'v_s',
      variantName: 'Small',
      variantPrice: '990',
    };
    const onConfirm = vi.fn();
    render(
      <ModifierPickerDialog
        item={item}
        groupsById={new Map([[extras.id, extras]])}
        initialLine={initial}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );
    // Variant hydration wins over `isDefault`: Small was picked on the
    // existing line, so Small is the checked radio (not Large the default).
    const rg = screen.getByRole('radiogroup');
    const checked = within(rg).getAllByRole('radio').filter(
      (r) => r.getAttribute('aria-checked') === 'true',
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]?.textContent).toMatch(/Small/);
    // Modifier hydration.
    expect(
      (screen.getByRole('checkbox', { name: /Chicken/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByRole('checkbox', { name: /Cheese/ }) as HTMLInputElement).checked,
    ).toBe(false);
    // Notes + qty.
    expect((screen.getByLabelText(/special instructions/i) as HTMLInputElement).value).toBe(
      'no coriander',
    );
    expect(document.body.textContent).toMatch(/\b3\b/);
    // Primary action reads "Update item" (not "Add to Cart").
    expect(screen.queryByRole('button', { name: /add to cart/i })).toBeNull();
    const cta = screen.getByRole('button', { name: /update item/i });
    // And it preserves the existing key on submit.
    fireEvent.click(cta);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const line = (onConfirm.mock.calls[0]?.[0] as DraftLine[])[0]!;
    expect(line.key).toBe('k_existing');
    expect(line.productVariantId).toBe('v_s');
    expect(line.sourceKind).toBe('PRODUCT');
  });

  // ── CW1 / CW2: cart-line rendering guarantees are asserted by the DraftLine
  // shape the dialog emits — the counter workspace's CartLineRow renders
  // `line.variantName` unconditionally when set, and skips the row when not.
  // A separate workspace-level render test is prohibitive to set up (the
  // counter workspace pulls the auth context, router, live catalogue fetch),
  // so the guarantees are asserted here at the emission boundary: a
  // catalogue-sourced line always carries `variantName` when a variant is
  // picked, and a legacy line never does.

  it('CW1/CW2: emitted DraftLine carries variantName for PRODUCT source, undefined for legacy', () => {
    // PRODUCT with variant selected.
    const item = productItem({
      variants: [variant({ id: 'v_m', name: 'Medium', unitPrice: 1290, isDefault: true })],
    });
    const onConfirmProduct = vi.fn();
    render(
      <ModifierPickerDialog
        item={item}
        groupsById={NO_GROUPS}
        onCancel={() => {}}
        onConfirm={onConfirmProduct}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /add to cart/i }));
    const pLine = (onConfirmProduct.mock.calls[0]?.[0] as DraftLine[])[0]!;
    expect(pLine.variantName).toBe('Medium');
    expect(pLine.sourceKind).toBe('PRODUCT');
    expect(pLine.productId).toBe(item.id);
    cleanup();

    // Legacy MENU_ITEM — no variants, no catalogueSource. Emits with
    // sourceKind='MENU_ITEM' and NO variantName/variantPrice.
    const onConfirmLegacy = vi.fn();
    render(
      <ModifierPickerDialog
        item={legacyMenuItem()}
        groupsById={NO_GROUPS}
        onCancel={() => {}}
        onConfirm={onConfirmLegacy}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /add to cart/i }));
    const lLine = (onConfirmLegacy.mock.calls[0]?.[0] as DraftLine[])[0]!;
    expect(lLine.variantName).toBeUndefined();
    expect(lLine.variantPrice).toBeUndefined();
    expect(lLine.productVariantId).toBeUndefined();
    expect(lLine.productId).toBeUndefined();
    expect(lLine.sourceKind).toBe('MENU_ITEM');
  });
});
