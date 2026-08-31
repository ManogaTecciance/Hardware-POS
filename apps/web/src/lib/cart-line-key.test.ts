import { describe, expect, it } from 'vitest';

import { cartLineKey, computeLine, linePrice, newCartItem, type CartItem } from './cart';
import type { ClientProduct, ClientVariant } from './catalog';

/**
 * D99 (1c.2) — the cart is keyed by (product, variant), not by product.
 *
 * Before this, every cart operation matched on `it.product.id`, so a Medium and a
 * Large of one shirt collapsed into a single line: `addToCart` found the product
 * already present and incremented it. These pin the identity rule and the two
 * places that read stock and price off the chosen variant rather than the product.
 *
 * The store itself is a React context, so the reducers are exercised through the
 * pure pieces they are built from — the key, the factory, and the line maths.
 */

function product(over: Partial<ClientProduct> = {}): ClientProduct {
  return {
    id: 'prod_shirt',
    name: 'Cotton Shirt',
    sku: null,
    type: 'Inventory',
    categoryName: 'Apparel',
    subcategoryId: null,
    subcategoryName: null,
    unitPrice: null, // a variant product owns no price of its own
    quantityOnHand: 20,
    reorderLevel: null,
    imageUrl: null,
    variants: [],
    ...over,
  };
}

function variant(over: Partial<ClientVariant> = {}): ClientVariant {
  return {
    id: 'var_m',
    sku: 'SHIRT-M',
    name: 'Black / Medium',
    unitPrice: 2500,
    isDefault: false,
    quantityOnHand: 3,
    stockState: 'IN_STOCK',
    ...over,
  };
}

describe('cartLineKey', () => {
  it('keys a variant-less line with an empty variant half', () => {
    // Both halves are always present so the format cannot be ambiguous. A cart
    // persisted before 1c.2 is migrated through this same function on hydration,
    // so old lines get the same shape rather than a bare product id.
    expect(cartLineKey('prod_rice', null)).toBe('prod_rice::');
  });

  it('distinguishes two variants of the same product', () => {
    const medium = cartLineKey('prod_shirt', 'var_m');
    const large = cartLineKey('prod_shirt', 'var_l');

    expect(medium).not.toBe(large);
    // Both still name their product, so a key can be read back if ever needed.
    expect(medium.startsWith('prod_shirt')).toBe(true);
  });

  it('is stable for the same pair', () => {
    expect(cartLineKey('p', 'v')).toBe(cartLineKey('p', 'v'));
  });

  it('does not collide a variant line with a product whose id contains the delimiter', () => {
    // Both halves are always present, so `("prod_shirt", "var_m")` gives
    // "prod_shirt::var_m" while `("prod_shirt::var_m", null)` gives
    // "prod_shirt::var_m::" — unambiguous whatever an id contains. Keying a
    // variant-less line on the bare product id collided here, which is what
    // this test caught.
    expect(cartLineKey('prod_shirt', 'var_m')).not.toBe(cartLineKey('prod_shirt::var_m', null));
  });
});

describe('newCartItem', () => {
  it('carries the variant and a matching key', () => {
    const v = variant();
    const item = newCartItem(product(), v);

    expect(item.variant).toBe(v);
    expect(item.lineKey).toBe(cartLineKey('prod_shirt', 'var_m'));
    expect(item.quantity).toBe(1);
  });

  it('defaults to no variant, so pre-picker callers keep working', () => {
    const item = newCartItem(product({ unitPrice: 999, variants: [] }));

    expect(item.variant).toBeNull();
    expect(item.lineKey).toBe(cartLineKey('prod_shirt', null));
  });
});

describe('two sizes of one product are two lines', () => {
  /** The merge rule `addToCart` applies, in isolation from the React store. */
  function addTo(items: CartItem[], p: ClientProduct, v: ClientVariant | null): CartItem[] {
    const key = cartLineKey(p.id, v?.id ?? null);
    const found = items.find((it) => it.lineKey === key);
    return found
      ? items.map((it) => (it.lineKey === key ? { ...it, quantity: it.quantity + 1 } : it))
      : [...items, newCartItem(p, v)];
  }

  it('appends rather than merging when the variant differs', () => {
    const p = product();
    const medium = variant({ id: 'var_m', sku: 'SHIRT-M' });
    const large = variant({ id: 'var_l', sku: 'SHIRT-L' });

    let items: CartItem[] = [];
    items = addTo(items, p, medium);
    items = addTo(items, p, large);

    expect(items).toHaveLength(2);
    expect(items.map((it) => it.variant?.sku)).toEqual(['SHIRT-M', 'SHIRT-L']);
  });

  it('still merges when the same variant is added twice', () => {
    const p = product();
    const medium = variant();

    let items: CartItem[] = [];
    items = addTo(items, p, medium);
    items = addTo(items, p, medium);

    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(2);
  });

  it('removing one size leaves the other', () => {
    const p = product();
    const items = [newCartItem(p, variant({ id: 'var_m' })), newCartItem(p, variant({ id: 'var_l' }))];

    // The defect a product-keyed filter would cause: both lines share a product
    // id, so removing by product would empty the cart.
    const after = items.filter((it) => it.lineKey !== cartLineKey('prod_shirt', 'var_m'));

    expect(after).toHaveLength(1);
    expect(after[0]!.variant?.id).toBe('var_l');
  });
});

describe('linePrice', () => {
  it('charges the variant price when a variant is chosen', () => {
    const item = newCartItem(product({ unitPrice: null }), variant({ unitPrice: 2500 }));
    expect(linePrice(item)).toBe(2500);
  });

  it('charges the product price when there is no variant', () => {
    const item = newCartItem(product({ unitPrice: 1200 }));
    expect(linePrice(item)).toBe(1200);
  });

  it('falls back to 0 rather than to a plausible wrong number', () => {
    // A variant product with no variant chosen has no price. Zero is visibly
    // wrong and gets reported; a product-level number would look right and ship.
    const item = newCartItem(product({ unitPrice: null }));
    expect(linePrice(item)).toBe(0);
  });
});

describe('outOfStock is judged against the variant', () => {
  it('flags a line that exceeds the variant stock, even when the product has plenty', () => {
    // 20 on the product across all sizes, 3 Mediums. Four Mediums is short.
    const item: CartItem = {
      ...newCartItem(product({ quantityOnHand: 20 }), variant({ quantityOnHand: 3 })),
      quantity: 4,
    };

    expect(computeLine(item).outOfStock).toBe(true);
  });

  it('does not flag a line within the variant stock', () => {
    const item: CartItem = {
      ...newCartItem(product({ quantityOnHand: 20 }), variant({ quantityOnHand: 3 })),
      quantity: 3,
    };

    expect(computeLine(item).outOfStock).toBe(false);
  });

  it('never flags an untracked variant', () => {
    const item: CartItem = {
      ...newCartItem(
        product(),
        variant({ stockState: 'UNTRACKED', quantityOnHand: null }),
      ),
      quantity: 99,
    };

    expect(computeLine(item).outOfStock).toBe(false);
  });

  it('uses the product quantity when there is no variant', () => {
    const item: CartItem = { ...newCartItem(product({ quantityOnHand: 2 })), quantity: 3 };
    expect(computeLine(item).outOfStock).toBe(true);
  });
});
