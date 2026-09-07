import { describe, expect, it } from 'vitest';

import { computeLine, computeTotals, stockCap, type CartItem } from './cart';
import type { ClientProduct } from './catalog';

/**
 * The cart's stock verdict, which gates the Pay button.
 *
 * The distinction these pin down is the one the POS got wrong: only Inventory
 * products track stock. QuickBooks stores 0 on Service and Non-Inventory items
 * as a placeholder — the app writes that 0 itself and shows "Not tracked" for it
 * elsewhere — so reading it as "sold out" made every one of them unsellable.
 */
function product(over: Partial<ClientProduct> = {}): ClientProduct {
  return {
    id: 'p1',
    name: 'Thing',
    sku: 'SKU-1',
    type: 'Inventory',
    unitPrice: 100,
    quantityOnHand: 10,
    categoryId: null,
    categoryName: 'Uncategorized',
    imageUrl: null,
    ...over,
  } as ClientProduct;
}

const line = (over: Partial<ClientProduct>, quantity: number): CartItem => ({
  product: product(over),
  quantity,
});

describe('what counts as a stock cap', () => {
  it('caps an Inventory product at its stock on hand', () => {
    expect(stockCap(product({ quantityOnHand: 4 }))).toBe(4);
  });

  it('caps a sold-out Inventory product at zero, not at nothing', () => {
    // 0 is a real cap; null would mean "sells freely", which is the opposite.
    expect(stockCap(product({ quantityOnHand: 0 }))).toBe(0);
  });

  it('does not cap products that do not track stock', () => {
    expect(stockCap(product({ type: 'NonInventory', quantityOnHand: 0 }))).toBeNull();
    expect(stockCap(product({ type: 'Service', quantityOnHand: 0 }))).toBeNull();
  });
});

describe('the out-of-stock verdict on a cart line', () => {
  it('flags an Inventory line that asks for more than is on hand', () => {
    expect(computeLine(line({ quantityOnHand: 2 }, 3)).outOfStock).toBe(true);
  });

  it('allows an Inventory line that takes exactly what is left', () => {
    expect(computeLine(line({ quantityOnHand: 3 }, 3)).outOfStock).toBe(false);
  });

  it('flags a sold-out Inventory line at any quantity', () => {
    expect(computeLine(line({ quantityOnHand: 0 }, 1)).outOfStock).toBe(true);
  });

  it('never flags a Non-Inventory line, whatever its stored quantity says', () => {
    // The regression: POL-1976 is NonInventory at 0 and was reading "Only 0 in
    // stock", which blocked the Pay button for the whole cart.
    expect(computeLine(line({ type: 'NonInventory', quantityOnHand: 0 }, 1)).outOfStock).toBe(
      false,
    );
    expect(computeLine(line({ type: 'NonInventory', quantityOnHand: 0 }, 99)).outOfStock).toBe(
      false,
    );
  });

  it('never flags a Service line', () => {
    expect(computeLine(line({ type: 'Service', quantityOnHand: 0 }, 5)).outOfStock).toBe(false);
  });
});

describe('the cart-wide stock gate behind the Pay button', () => {
  const totals = (items: CartItem[]) => computeTotals(items, 0);

  it('stays clear for a cart of items that do not track stock', () => {
    expect(
      totals([
        line({ type: 'NonInventory', quantityOnHand: 0 }, 3),
        line({ type: 'Service', quantityOnHand: 0 }, 1),
      ]).hasStockIssue,
    ).toBe(false);
  });

  it('trips when any Inventory line is short', () => {
    expect(
      totals([
        line({ type: 'NonInventory', quantityOnHand: 0 }, 3),
        line({ id: 'p2', quantityOnHand: 1 }, 5),
      ]).hasStockIssue,
    ).toBe(true);
  });

  it('does not let one untracked item poison an otherwise sellable cart', () => {
    expect(
      totals([
        line({ quantityOnHand: 10 }, 2),
        line({ id: 'p2', type: 'NonInventory', quantityOnHand: 0 }, 1),
      ]).hasStockIssue,
    ).toBe(false);
  });

  it('is clear for an empty cart', () => {
    expect(totals([]).hasStockIssue).toBe(false);
  });
});
