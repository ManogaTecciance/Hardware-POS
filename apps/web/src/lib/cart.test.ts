import { describe, expect, it } from 'vitest';

import {
  computeDiscount,
  computeLine,
  computeTotals,
  newCartItem,
  stockCap,
  type CartItem,
} from './cart';
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

// A line the way `newCartItem` makes one: keyed by (product, no variant). The
// cap these tests are about reads the PRODUCT's count when there is no variant.
const line = (over: Partial<ClientProduct>, quantity: number): CartItem => ({
  ...newCartItem(product(over), null),
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


/**
 * A fixed discount can come off each unit or off the line as a whole. The two
 * are indistinguishable at quantity 1 and diverge the moment the cashier taps
 * the tile again, so the basis has to travel with the discount rather than be
 * inferred.
 */
describe('a fixed discount per unit vs per line', () => {
  const threeAtAThousand = (basis?: 'LINE' | 'UNIT'): CartItem => ({
    ...newCartItem(product({ unitPrice: 1000 }), null),
    quantity: 3,
    discount: { type: 'FIXED', value: 100, ...(basis ? { basis } : {}) },
  });

  it('takes the amount once for a whole-line discount', () => {
    const line = computeLine(threeAtAThousand('LINE'));
    expect(line.discountAmount).toBe(100);
    expect(line.lineTotal).toBe(2900);
  });

  it('takes the amount from every unit for a per-unit discount', () => {
    const line = computeLine(threeAtAThousand('UNIT'));
    expect(line.discountAmount).toBe(300);
    expect(line.lineTotal).toBe(2700);
  });

  it('reads a discount with no basis as whole-line', () => {
    // A cart restored from an older session has no basis on its discounts and
    // must keep the meaning it was rung up with.
    expect(computeLine(threeAtAThousand()).discountAmount).toBe(100);
  });

  it('floors the line at zero rather than going negative', () => {
    // A negative line would pay money out through the proportional reversal a
    // return performs.
    const line = computeLine({
      ...newCartItem(product({ unitPrice: 1000 }), null),
      quantity: 3,
      discount: { type: 'FIXED', value: 2000, basis: 'UNIT' },
    });
    expect(line.discountAmount).toBe(3000);
    expect(line.lineTotal).toBe(0);
  });

  it('ignores the basis on a percentage', () => {
    // A percentage is already the same figure per unit and per line.
    const line = computeLine({
      ...newCartItem(product({ unitPrice: 1000 }), null),
      quantity: 3,
      discount: { type: 'PERCENTAGE', value: 10, basis: 'UNIT' },
    });
    expect(line.discountAmount).toBe(300);
  });

  it('is the same either way at a quantity of one', () => {
    const one = (basis: 'LINE' | 'UNIT') =>
      computeLine({
        ...newCartItem(product({ unitPrice: 1000 }), null),
        quantity: 1,
        discount: { type: 'FIXED', value: 100, basis },
      }).discountAmount;
    expect(one('LINE')).toBe(one('UNIT'));
  });

  it('multiplies before rounding, as the server does', () => {
    // round2(33.333 * 3) = 100.00, but round2(33.333) * 3 = 99.99. A cent of
    // disagreement with the server makes the sale complete as part-paid.
    const line = computeLine({
      ...newCartItem(product({ unitPrice: 1000 }), null),
      quantity: 3,
      discount: { type: 'FIXED', value: 33.333, basis: 'UNIT' },
    });
    expect(line.discountAmount).toBe(100);
  });

  it('leaves the whole-cart discount alone, which has no units', () => {
    // computeDiscount is shared with the order discount; its caller passes no
    // quantity and a fixed cart discount must stay the amount it says.
    expect(computeDiscount(5000, { type: 'FIXED', value: 100 })).toBe(100);
  });

  it('feeds the per-unit amount into the cart totals', () => {
    const totals = computeTotals([threeAtAThousand('UNIT')], 0);
    expect(totals.totalDiscount).toBe(300);
    expect(totals.total).toBe(2700);
  });
});
