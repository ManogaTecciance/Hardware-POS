import { describe, expect, it } from 'vitest';

import { needsVariantChoice, quickAddVariant } from './variant-picker-dialog';
import type { ClientProduct, ClientVariant } from '@/lib/catalog';

/**
 * D99 (1c.4) — the quick-add ladder.
 *
 * The whole behaviour of the picker step is *when it does not open*: a grocery
 * item, a single-option product and a default size must all still be one tap.
 * Proving that as a function is exhaustive in a way DOM tests are not.
 */

function variant(over: Partial<ClientVariant> = {}): ClientVariant {
  return {
    id: 'var_m',
    sku: 'SHIRT-M',
    name: 'Medium',
    unitPrice: 2500,
    isDefault: false,
    quantityOnHand: 5,
    stockState: 'IN_STOCK',
    ...over,
  };
}

function product(variants: ClientVariant[] = []): ClientProduct {
  return {
    id: 'prod_shirt',
    name: 'Cotton Shirt',
    sku: null,
    type: 'Inventory',
    categoryName: 'Apparel',
    subcategoryId: null,
    subcategoryName: null,
    unitPrice: variants.length > 0 ? null : 1500,
    quantityOnHand: 20,
    reorderLevel: null,
    imageUrl: null,
    variants,
  };
}

describe('quickAddVariant — when the till does not need to ask', () => {
  it('adds nothing for a product with no variants', () => {
    // Grocery loose goods, hardware, a service. Unchanged from before variants.
    const p = product();
    expect(quickAddVariant(p)).toBeNull();
    expect(needsVariantChoice(p)).toBe(false);
  });

  it('adds the only option without opening a one-row modal', () => {
    const only = variant({ id: 'var_only' });
    const p = product([only]);

    expect(quickAddVariant(p)?.id).toBe('var_only');
    expect(needsVariantChoice(p)).toBe(false);
  });

  it('adds the variant marked isDefault (D45 quick-add)', () => {
    const p = product([
      variant({ id: 'var_s', name: 'Small' }),
      variant({ id: 'var_m', name: 'Medium', isDefault: true }),
      variant({ id: 'var_l', name: 'Large' }),
    ]);

    expect(quickAddVariant(p)?.id).toBe('var_m');
    expect(needsVariantChoice(p)).toBe(false);
  });
});

describe('quickAddVariant — when it must ask', () => {
  it('asks when there are several options and no default', () => {
    const p = product([
      variant({ id: 'var_s', name: 'Small' }),
      variant({ id: 'var_l', name: 'Large' }),
    ]);

    expect(quickAddVariant(p)).toBeNull();
    expect(needsVariantChoice(p)).toBe(true);
  });
});

describe('out-of-stock options never quick-add', () => {
  it('ignores a sold-out default and asks instead', () => {
    // Quick-adding a size that cannot be sold puts a line in the cart the server
    // refuses at checkout — worse than one extra tap.
    const p = product([
      variant({ id: 'var_m', isDefault: true, stockState: 'OUT', quantityOnHand: 0 }),
      variant({ id: 'var_s', name: 'Small' }),
      variant({ id: 'var_l', name: 'Large' }),
    ]);

    expect(quickAddVariant(p)).toBeNull();
    expect(needsVariantChoice(p)).toBe(true);
  });

  it('treats one sellable option among sold-out siblings as the only option', () => {
    const p = product([
      variant({ id: 'var_s', stockState: 'OUT', quantityOnHand: 0 }),
      variant({ id: 'var_m', name: 'Medium' }),
      variant({ id: 'var_l', stockState: 'OUT', quantityOnHand: 0 }),
    ]);

    // Only one can actually be sold, so asking would be a pointless tap.
    expect(quickAddVariant(p)?.id).toBe('var_m');
    expect(needsVariantChoice(p)).toBe(false);
  });

  it('falls back to the sole sellable option when the default is sold out', () => {
    const p = product([
      variant({ id: 'var_m', isDefault: true, stockState: 'OUT', quantityOnHand: 0 }),
      variant({ id: 'var_l', name: 'Large' }),
    ]);

    expect(quickAddVariant(p)?.id).toBe('var_l');
  });

  it('asks when every option is sold out rather than adding one', () => {
    const p = product([
      variant({ id: 'var_s', stockState: 'OUT', quantityOnHand: 0 }),
      variant({ id: 'var_m', stockState: 'OUT', quantityOnHand: 0 }),
    ]);

    expect(quickAddVariant(p)).toBeNull();
    // The card's own out-of-stock guard disables the button before this matters;
    // the picker would show every row disabled if it were somehow reached.
    expect(needsVariantChoice(p)).toBe(true);
  });
});

describe('untracked stock is sellable', () => {
  it('quick-adds an untracked default', () => {
    // A tenant that tracks no stock has no quantities to compare — UNTRACKED is
    // a real state, not a zero, and must not read as sold out.
    const p = product([
      variant({ id: 'var_a', isDefault: true, stockState: 'UNTRACKED', quantityOnHand: null }),
      variant({ id: 'var_b', stockState: 'UNTRACKED', quantityOnHand: null }),
    ]);

    expect(quickAddVariant(p)?.id).toBe('var_a');
  });
});
